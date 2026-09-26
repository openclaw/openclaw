import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { readOpenClawAgentDatabaseRegistryToken } from "./openclaw-agent-db-registry-listing.js";
import { unregisterOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture() {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-creation-witness-")) };
  const options = { agentId: "main", env };
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

function source(
  beforeGrant: (request: SqliteWorkerAdmissionRequest) => void = () => {},
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent() {},
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          beforeGrant(request);
          binding.authorize(request);
          if (!grant()) {
            throw new Error("Creation witness fixture lost admission");
          }
        }, binding.attachment),
      });
    },
  };
}

it("shares an execution owner across directory aliases, later turns, and cleanup", async () => {
  const options = fixture();
  const alias = path.join(options.env.OPENCLAW_STATE_DIR, "alias");
  const directory = path.dirname(options.path);
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const aliased = { ...options, path: path.join(alias, path.basename(options.path)) };
  const creator = captureOpenClawAgentDatabaseExecution(aliased, {
    expectedCreationIdentity: readDatabasePathIdentitySync(aliased.path),
  });
  const sibling = captureOpenClawAgentDatabaseExecution(options);
  const sessionKey = "agent:main:alias-proof";
  const command = {
    type: "session.transcript.initialize" as const,
    input: { sessionKey, sessionId: "alias-session" },
  };
  const existingTranscript = { kind: "session-transcript-initialized", sessionKey };
  try {
    await creator.prepare(source());
    await expect(creator.runExisting(source(), (scope) => scope.execute(command))).resolves.toEqual(
      {
        ...existingTranscript,
        placeholder: { sessionId: "alias-session" },
      },
    );
    await expect(sibling.runExisting(source(), (scope) => scope.execute(command))).resolves.toEqual(
      existingTranscript,
    );
    expect(sibling.path).toBe(options.path);
    expect(sibling.fileIdentity).toEqual(creator.fileIdentity);
    await Promise.all([creator.release(), sibling.release()]);
    const later = captureOpenClawAgentDatabaseExecution(options);
    try {
      await expect(later.runExisting(source(), (scope) => scope.execute(command))).resolves.toEqual(
        existingTranscript,
      );
      await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
      expect(() => later.assertCurrent()).toThrow(/closed/);
    } finally {
      await later.release();
    }
    const reopened = captureOpenClawAgentDatabaseExecution(aliased);
    try {
      await expect(
        reopened.runExisting(source(), (scope) => scope.execute(command)),
      ).resolves.toEqual(existingTranscript);
      await closeOpenClawAgentDatabaseByPathAsync(aliased.path, options.agentId);
      expect(() => reopened.assertCurrent()).toThrow(/closed/);
    } finally {
      await reopened.release();
    }
    fs.unlinkSync(options.path);
    const replacement = captureOpenClawAgentDatabaseExecution(options, {
      expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
    });
    try {
      await replacement.prepare(source());
      await expect(
        replacement.runExisting(source(), (scope) => scope.execute(command)),
      ).resolves.toEqual({
        ...existingTranscript,
        placeholder: { sessionId: "alias-session" },
      });
    } finally {
      await replacement.release();
    }
  } finally {
    await Promise.allSettled([creator.release(), sibling.release()]);
  }
});

it.each(["missing", "schema-missing"] as const)(
  "prepares its originally observed %s store and records native birth without changing identity",
  async (kind) => {
    const options = fixture();
    if (kind === "schema-missing") {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      fs.writeFileSync(options.path, "");
    }
    const observed = readDatabasePathIdentitySync(options.path);
    const execution = captureOpenClawAgentDatabaseExecution(options, {
      expectedCreationIdentity: observed,
    });
    try {
      expect(execution.fileIdentity).toBeUndefined();
      await execution.prepare(source());
      const physical = readDatabasePathIdentitySync(options.path);
      expect(physical.canonicalPath).toBe(observed.canonicalPath);
      if (kind === "schema-missing") {
        expect(physical).toEqual(observed);
      }
      expect(execution.fileIdentity).toMatchObject({
        kind: "file",
        physicalIdentity: physical.key.slice("file:".length),
        birthtime: physical.birthtime,
      });
      await expect(execution.runExisting(source(), async () => "retained")).resolves.toBe(
        "retained",
      );
      const unrelatedInitialization = vi.fn(() => {
        throw new Error("A warm borrower must not recapture initialization configuration");
      });
      const env = { ...options.env };
      if (process.platform !== "win32") {
        Object.defineProperty(env, "UNRELATED_INITIALIZATION", {
          enumerable: true,
          get: unrelatedInitialization,
        });
      }
      const warm = captureOpenClawAgentDatabaseExecution({
        ...options,
        env,
      });
      try {
        await expect(warm.runExisting(source(), async () => "warm")).resolves.toBe("warm");
        expect(unrelatedInitialization).not.toHaveBeenCalled();
      } finally {
        await warm.release();
      }
      const windows = (() => {
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        try {
          return captureOpenClawAgentDatabaseExecution({
            ...options,
            env: {
              HOME: options.env.OPENCLAW_STATE_DIR,
              OpenClaw_State_Dir: options.env.OPENCLAW_STATE_DIR,
            },
          });
        } finally {
          platform.mockRestore();
        }
      })();
      try {
        await expect(windows.runExisting(source(), async () => "same owner")).resolves.toBe(
          "same owner",
        );
      } finally {
        await windows.release();
      }
      expect(() =>
        captureOpenClawAgentDatabaseExecution(options, {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: physical.key.slice("file:".length),
            nativeLocation: physical.canonicalPath,
            birthtime: (fs.statSync(options.path, { bigint: true }).birthtimeNs + 1n).toString(),
          },
        }),
      ).toThrow(/identity|physical file/);
    } finally {
      await execution.release();
    }
  },
);

it.each(["fresh root", "existing root", "existing agent"] as const)(
  "preserves a relative registration through native opening, relocation, and removal (%s alias)",
  async (layout) => {
    const options = fixture();
    const alias = path.join(tempDirs.make("agent-registry-alias-"), "state");
    fs.symlinkSync(
      options.env.OPENCLAW_STATE_DIR,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
    const aliased =
      layout === "existing agent"
        ? options
        : {
            ...options,
            env: { OPENCLAW_STATE_DIR: alias },
            path: path.join(alias, relative),
          };
    if (layout === "existing agent") {
      fs.mkdirSync(path.dirname(path.dirname(options.path)), { recursive: true });
      fs.symlinkSync(
        tempDirs.make("agent-registry-external-"),
        path.dirname(options.path),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    if (layout !== "fresh root") {
      openOpenClawAgentDatabase(aliased);
      await closeOpenClawAgentDatabasesAsync();
    }
    const state = openOpenClawStateDatabase({ env: aliased.env });
    const registrations = () => state.db.prepare("SELECT path FROM agent_databases").all();
    expect(registrations()).toEqual(layout === "fresh root" ? [] : [{ path: relative }]);
    const execution = captureOpenClawAgentDatabaseExecution(aliased);
    try {
      await execution.prepare(source());
      expect(registrations()).toEqual([{ path: relative }]);
    } finally {
      await execution.release();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
    }
    const relocated = fs.realpathSync(tempDirs.make("agent-registry-relocated-"));
    fs.cpSync(options.env.OPENCLAW_STATE_DIR, relocated, { recursive: true });
    expect(
      listOpenClawRegisteredAgentDatabases({ env: { OPENCLAW_STATE_DIR: relocated } }),
    ).toEqual([expect.objectContaining({ agentId: "main", path: path.join(relocated, relative) })]);
    unregisterOpenClawAgentDatabase({ ...aliased, path: fs.realpathSync(aliased.path) });
    expect(listOpenClawRegisteredAgentDatabases({ env: aliased.env })).toEqual([]);
  },
);

it.each(["before witness", "after witness"] as const)(
  "reserves schema-missing first birth against a sibling captured %s",
  async (when) => {
    const options = fixture();
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
    fs.writeFileSync(options.path, "");
    const observed = readDatabasePathIdentitySync(options.path);
    const early =
      when === "before witness" ? captureOpenClawAgentDatabaseExecution(options) : undefined;
    const creator = captureOpenClawAgentDatabaseExecution(options, {
      expectedCreationIdentity: observed,
    });
    const sibling = early ?? captureOpenClawAgentDatabaseExecution(options);
    try {
      await expect(sibling.prepare(source())).rejects.toThrow(/captured creating reference/);
      expect(fs.readFileSync(options.path)).toHaveLength(0);
      await creator.prepare(source());
      await expect(sibling.prepare(source())).resolves.toBeUndefined();
      expect(sibling.fileIdentity).toEqual(creator.fileIdentity);
    } finally {
      await Promise.allSettled([creator.release(), sibling.release()]);
    }
  },
);

it("refuses an absent witness when another logical owner was captured first", async () => {
  const options = fixture();
  const observed = readDatabasePathIdentitySync(options.path);
  const sibling = captureOpenClawAgentDatabaseExecution(options);
  try {
    expect(() =>
      captureOpenClawAgentDatabaseExecution(options, { expectedCreationIdentity: observed }),
    ).toThrow(/originally observed target/);
    expect(fs.existsSync(options.path)).toBe(false);
  } finally {
    await sibling.release();
  }
});

it.each(["missing", "schema-missing"] as const)(
  "releases an unused %s creation reservation while a sibling remains",
  async (kind) => {
    const options = fixture();
    if (kind === "schema-missing") {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      fs.writeFileSync(options.path, "");
    }
    const observed = readDatabasePathIdentitySync(options.path);
    const creator = captureOpenClawAgentDatabaseExecution(options, {
      expectedCreationIdentity: observed,
    });
    const sibling = captureOpenClawAgentDatabaseExecution(options);
    try {
      await creator.release();
      expect(readDatabasePathIdentitySync(options.path)).toEqual(observed);
      await sibling.prepare(source());
      expect(sibling.fileIdentity).toMatchObject({ kind: "file" });
      await expect(sibling.runExisting(source(), async () => "prepared")).resolves.toBe("prepared");
    } finally {
      await Promise.allSettled([creator.release(), sibling.release()]);
    }
  },
);

it.each(["missing", "schema-missing"] as const)(
  "releases a %s creation reservation after source refusal before native opening",
  async (kind) => {
    const options = fixture();
    if (kind === "schema-missing") {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      fs.writeFileSync(options.path, "");
    }
    const observed = readDatabasePathIdentitySync(options.path);
    const creator = captureOpenClawAgentDatabaseExecution(options, {
      expectedCreationIdentity: observed,
    });
    const sibling = captureOpenClawAgentDatabaseExecution(options);
    const refusal = new Error("Original creation source ended before native opening");
    const revoked = source();
    revoked.assertCurrent = () => {
      throw refusal;
    };
    const admit = vi.spyOn(revoked, "createAdmission");
    try {
      await expect(creator.prepare(revoked)).rejects.toBe(refusal);
      expect(admit).not.toHaveBeenCalled();
      expect(creator.fileIdentity).toBeUndefined();
      expect(readDatabasePathIdentitySync(options.path)).toEqual(observed);
      await creator.release();
      await sibling.prepare(source());
      expect(sibling.fileIdentity).toMatchObject({ kind: "file" });
      await expect(sibling.runExisting(source(), async () => "prepared")).resolves.toBe("prepared");
    } finally {
      admit.mockRestore();
      await Promise.allSettled([creator.release(), sibling.release()]);
    }
  },
);

it("joins native creating admission before releasing its original reservation", async () => {
  const options = fixture();
  const creator = captureOpenClawAgentDatabaseExecution(options, {
    expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
  });
  const sibling = captureOpenClawAgentDatabaseExecution(options);
  const order: string[] = [];
  let releasing: Promise<void> | undefined;
  let siblingAttempt: Promise<unknown> | undefined;
  const preparing = creator
    .prepare(
      source((request) => {
        if (request.stage !== "open" || releasing) {
          return;
        }
        expect(sibling.fileIdentity).toBeUndefined();
        releasing = creator.release().then(() => {
          order.push("released");
        });
        siblingAttempt = sibling.prepare(source()).then(
          () => undefined,
          (error: unknown) => error,
        );
      }),
    )
    .then(() => {
      order.push("prepared");
    });
  try {
    await preparing;
    expect(releasing).toBeDefined();
    expect(await siblingAttempt).toMatchObject({
      message: expect.stringContaining("captured creating reference"),
    });
    await releasing;
    expect(order).toEqual(["prepared", "released"]);
    const identity = sibling.fileIdentity;
    expect(identity).toMatchObject({ kind: "file" });
    await sibling.prepare(source());
    expect(sibling.fileIdentity).toEqual(identity);
    await expect(sibling.runExisting(source(), async () => "retained")).resolves.toBe("retained");
  } finally {
    await Promise.allSettled([preparing, creator.release(), sibling.release()]);
  }
});

it("rechecks source authority after registration notification before authorizing native open", async () => {
  const options = fixture();
  readOpenClawAgentDatabaseRegistryToken({ env: options.env });
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const revoked = new Error("Creation source revoked by its registry notification");
  let current = true;
  const authorizedOpen = vi.fn();
  const requestSource: AgentDatabaseRequestExecutionSource = {
    assertCurrent() {
      if (!current) {
        throw revoked;
      }
    },
    onRegistryChange() {
      current = false;
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          if (request.stage === "open") {
            authorizedOpen();
          }
          if (!grant()) {
            throw new Error("Creation source lost admission");
          }
        }, binding.attachment),
      });
    },
  };
  try {
    await expect(execution.prepare(requestSource)).rejects.toThrow(revoked);
    expect(authorizedOpen).not.toHaveBeenCalled();
    expect(fs.existsSync(options.path)).toBe(false);
  } finally {
    await execution.release();
  }
});

it.skipIf(process.platform === "win32")(
  "rejects a warm database path replaced by its source callback before granting admission",
  async () => {
    const options = fixture();
    const retainedPath = `${options.path}.retained`;
    const execution = captureOpenClawAgentDatabaseExecution(options);
    let replaceOnAssertion = false;
    let replaced = false;
    const requestSource = source((request) => {
      replaceOnAssertion = request.stage === "prepare";
    });
    requestSource.assertCurrent = () => {
      if (replaceOnAssertion && !replaced) {
        fs.renameSync(options.path, retainedPath);
        fs.writeFileSync(options.path, "replacement path; not a database");
        replaced = true;
      }
    };
    try {
      await execution.prepare(source());
      await expect(
        execution.runExisting(requestSource, (scope) =>
          scope.execute({
            type: "session.entry.read",
            input: { sessionKey: "agent:main:missing" },
          }),
        ),
      ).rejects.toThrow(/identity changed/);
      expect(replaced).toBe(true);
    } finally {
      if (replaced) {
        fs.unlinkSync(options.path);
        fs.renameSync(retainedPath, options.path);
      }
      await execution.release();
    }
  },
);

it("reserves absent first birth and refuses a competitor introduced at the native open boundary", async () => {
  const options = fixture();
  const creator = captureOpenClawAgentDatabaseExecution(options, {
    expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
  });
  const sibling = captureOpenClawAgentDatabaseExecution(options);
  let replaced = false;
  try {
    await expect(sibling.prepare(source())).rejects.toThrow(/captured creating reference/);
    expect(fs.existsSync(options.path)).toBe(false);
    await expect(
      creator.prepare(
        source((request) => {
          if (
            !replaced &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "shared-owner"
          ) {
            fs.mkdirSync(path.dirname(options.path), { recursive: true });
            fs.writeFileSync(options.path, "");
            replaced = true;
          }
        }),
      ),
    ).rejects.toThrow(/changed before creating open/);
    expect(replaced).toBe(true);
    expect(fs.readFileSync(options.path)).toHaveLength(0);
  } finally {
    await Promise.allSettled([creator.release(), sibling.release()]);
  }
});

it.each(["missing", "stale"] as const)(
  "refuses %s original FILE birthtime before writable preparation",
  async (kind) => {
    const options = fixture();
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
    fs.writeFileSync(options.path, "");
    const observed = readDatabasePathIdentitySync(options.path);
    const birthtime = fs.statSync(options.path, { bigint: true }).birthtimeNs;
    expect(() =>
      captureOpenClawAgentDatabaseExecution(options, {
        expectedCreationIdentity: {
          ...observed,
          birthtime: kind === "missing" ? undefined : (birthtime + 1n).toString(),
        },
      }),
    ).toThrow(/originally observed target/);
    expect(fs.readFileSync(options.path)).toHaveLength(0);
  },
);

it("retains canonical borrowers and rejects the changed alias before caller continuation", async () => {
  const options = fixture();
  const originalDirectory = path.join(options.env.OPENCLAW_STATE_DIR, "original");
  const successorDirectory = path.join(options.env.OPENCLAW_STATE_DIR, "successor");
  const alias = path.join(options.env.OPENCLAW_STATE_DIR, "selected");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.mkdirSync(originalDirectory);
  fs.mkdirSync(successorDirectory);
  fs.symlinkSync(originalDirectory, alias, linkType);
  const aliased = { ...options, path: path.join(alias, "agent.sqlite") };
  const successor = captureOpenClawAgentDatabaseExecution({
    ...options,
    path: path.join(successorDirectory, "agent.sqlite"),
  });
  const creator = captureOpenClawAgentDatabaseExecution(aliased, {
    expectedCreationIdentity: readDatabasePathIdentitySync(aliased.path),
  });
  const canonical = captureOpenClawAgentDatabaseExecution({
    ...options,
    path: path.join(originalDirectory, "agent.sqlite"),
  });
  const operation = vi.fn(async () => "must not enter successor");
  try {
    await successor.prepare(source());
    await creator.prepare(source());
    const receipt = creator.fileIdentity;
    expect(receipt).toBeDefined();
    expect(receipt?.physicalIdentity).not.toBe(successor.fileIdentity?.physicalIdentity);
    fs.unlinkSync(alias);
    fs.symlinkSync(successorDirectory, alias, linkType);
    expect(() => creator.assertCurrent()).toThrow(/identity|observed target/);
    expect(() => creator.fileIdentity).toThrow(/identity|observed target/);
    await expect(creator.runExisting(source(), operation)).rejects.toThrow(
      /identity|observed target/,
    );
    expect(operation).not.toHaveBeenCalled();
    await expect(
      canonical.runExisting(source(), (scope) =>
        scope.execute({
          type: "session.transcript.initialize",
          input: { sessionKey: "agent:main:retarget-proof", sessionId: "original-session" },
        }),
      ),
    ).resolves.toEqual({
      kind: "session-transcript-initialized",
      sessionKey: "agent:main:retarget-proof",
      placeholder: { sessionId: "original-session" },
    });
    expect(canonical.fileIdentity).toEqual(receipt);
    await closeOpenClawAgentDatabaseByPathAsync(aliased.path, options.agentId);
    expect(() => successor.assertCurrent()).not.toThrow();
    await expect(successor.runExisting(source(), async () => "successor retained")).resolves.toBe(
      "successor retained",
    );
  } finally {
    await Promise.allSettled([creator.release(), canonical.release(), successor.release()]);
  }
});
