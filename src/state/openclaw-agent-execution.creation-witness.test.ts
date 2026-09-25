import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

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
        }),
      });
    },
  };
}

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
    } finally {
      await execution.release();
    }
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

it("retains the prepared native receipt across an alias swap before caller continuation", async () => {
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
    expect(() => successor.assertCurrent()).not.toThrow();
  } finally {
    // Restore the test's directory alias so native cleanup addresses its original file.
    fs.unlinkSync(alias);
    fs.symlinkSync(originalDirectory, alias, linkType);
    await Promise.allSettled([creator.release(), successor.release()]);
  }
});
