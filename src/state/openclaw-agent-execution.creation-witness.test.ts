import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  readOpenClawAgentDatabaseRegistryToken,
} from "./openclaw-agent-db-registry-listing.js";
import { unregisterOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { getOpenClawAgentDatabaseValidationForTransfer } from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  agentCreationWitnessTempDirs as tempDirs,
  createAgentCreationWitnessFixture as fixture,
  createAgentCreationWitnessSource as source,
  createAliasedAgentCreationWitnessFixture as aliasedFixture,
} from "./openclaw-agent-execution.creation-fixture.test-support.js";
import { captureOpenClawAgentDatabaseExecution as capture } from "./openclaw-agent-execution.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

type Execution = ReturnType<typeof capture>;
type Options = ReturnType<typeof fixture>;

function onExit(cleanup: () => Promise<unknown>) {
  return {
    async [Symbol.asyncDispose]() {
      await cleanup();
    },
  };
}
function directoryAlias(target: string, alias: string) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}
function creatorFor(options: Options, observed = readDatabasePathIdentitySync(options.path)) {
  return capture(options, { expectedCreationIdentity: observed });
}
function emptyStore(options: Options) {
  fs.mkdirSync(path.dirname(options.path), { recursive: true });
  fs.writeFileSync(options.path, "");
}
function isPreparing(request: SqliteWorkerAdmissionRequest, kind: string) {
  return (
    request.stage === "prepare" &&
    request.facts !== null &&
    typeof request.facts === "object" &&
    "kind" in request.facts &&
    request.facts.kind === kind
  );
}
function releaseAll(...executions: (Execution | undefined)[]) {
  return Promise.allSettled(executions.map(async (execution) => execution?.release()));
}
function initialized(sessionKey: string, sessionId: string) {
  return {
    kind: "session-transcript-initialized",
    sessionKey,
    placeholder: { sessionId },
    transcriptPublication: transcriptPublication(sessionKey, sessionId),
  };
}
function existingTranscript(sessionKey: string) {
  return { kind: "session-transcript-initialized", sessionKey, transcriptPublication: undefined };
}
async function readAliasAndClose(
  options: Options,
  sessionKey: string,
  assertRegistry?: () => void,
) {
  const execution = capture(options);
  await using _ = onExit(() => execution.release());
  await expect(initialize(execution, sessionKey, "alias-session")).resolves.toEqual(
    existingTranscript(sessionKey),
  );
  assertRegistry?.();
  await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  expect(() => execution.assertCurrent()).toThrow(/closed/);
}
function initialize(execution: Execution, sessionKey: string, sessionId: string) {
  return execution.runExisting(source(), (scope) =>
    scope.execute({ type: "session.transcript.initialize", input: { sessionKey, sessionId } }),
  );
}

function transcriptPublication(sessionKey: string, sessionId: string) {
  return [
    expect.objectContaining({
      domain: "session-transcript-context",
      facts: new Map([
        [
          sessionKey,
          { kind: "postimage", value: expect.objectContaining({ sessionKey, sessionId }) },
        ],
      ]),
    }),
  ];
}

it("exposes a prepared generation only after registration publication and keeps its borrower live", async () => {
  const options = fixture();
  readOpenClawAgentDatabaseRegistryToken({ env: options.env });
  const execution = capture(options);
  let observedUnpublishedIdentity = false;
  const requestSource = source();
  requestSource.onRegistryChange = () => {
    // Registration publishes after the native identity is accepted. Neither boundary
    // alone permits another borrower to skip the remaining preparation.
    observedUnpublishedIdentity ||= execution.fileIdentity !== undefined;
    expect(execution.capturePreparedGenerationClaim()).toBeUndefined();
  };
  await using _ = onExit(() => execution.release());
  expect(execution.capturePreparedGenerationClaim()).toBeUndefined();
  await execution.prepare(requestSource);
  expect(observedUnpublishedIdentity).toBe(true);
  const claim = execution.capturePreparedGenerationClaim();
  expect(claim).toBeDefined();
  claim!.assertCurrent();
  const warmStages: string[] = [];
  const warmSource = source((request) => warmStages.push(request.stage));
  await Promise.all([execution.prepare(warmSource), execution.prepare(warmSource)]);
  await execution.prepare(warmSource);
  expect(warmStages).toEqual([]);
  claim!.assertCurrent();
  await execution.release();
  expect(() => execution.capturePreparedGenerationClaim()).toThrow(/released/);
  expect(() => claim!.assertCurrent()).toThrow(/released/);
});

it("refuses writable preparation after its captured physical file disappears", async () => {
  const options = fixture();
  openOpenClawAgentDatabase(options);
  await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  const execution = capture(options);
  await using _ = onExit(() => execution.release());
  fs.unlinkSync(options.path);

  await expect(execution.prepare(source())).rejects.toThrow(
    "Captured agent database file disappeared before writable preparation",
  );
  expect(fs.existsSync(options.path)).toBe(false);
});

it("retains both borrowers when config changes after a completed native open", async () => {
  const options = fixture();
  const previousConfig = getRuntimeConfigSnapshot();
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
  readOpenClawAgentDatabaseRegistryToken({ env: options.env });
  const original = capture(options);
  let fresh: ReturnType<typeof capture> | undefined;
  let preparingFresh: Promise<void> | undefined;
  let originalIncarnation: string | undefined;
  let publishedConfig = false;
  const requestSource = source();
  requestSource.onRegistryChange = () => {
    if (publishedConfig || !original.fileIdentity) {
      return;
    }
    publishedConfig = true;
    originalIncarnation = original.captureGenerationClaim().incarnation;
    setRuntimeConfigSnapshot({
      agents: { entries: { main: {} } },
      session: {
        store: path.join(options.env.OPENCLAW_STATE_DIR, "relocated", "{agentId}.sqlite"),
      },
    });
    fresh = capture(options);
    expect(fresh.capturePreparedGenerationClaim()).toBeUndefined();
    preparingFresh = fresh.prepare(source());
    void preparingFresh.catch(() => {});
  };
  try {
    await original.prepare(requestSource);
    assert(fresh);
    assert(preparingFresh);
    assert(originalIncarnation);
    await preparingFresh;
    const claim = fresh.capturePreparedGenerationClaim();
    assert(claim);
    expect(claim.incarnation).toBe(originalIncarnation);
    claim.assertCurrent();
    original.assertCurrent();
  } finally {
    await preparingFresh?.catch(() => {});
    await original.release();
    await fresh?.release();
    if (previousConfig) {
      setRuntimeConfigSnapshot(previousConfig);
    } else {
      clearRuntimeConfigSnapshot();
    }
  }
});

it("shares an execution owner across directory aliases, later turns, and cleanup", async () => {
  const { options, aliased } = aliasedFixture();
  const creator = creatorFor(aliased);
  const sibling = capture(options);
  const sessionKey = "agent:main:alias-proof";
  await using _ = onExit(() => releaseAll(creator, sibling));
  await creator.prepare(source());
  const registry = await prepareOpenClawAgentDatabaseRegistrySnapshotRead({
    env: options.env,
  }).read();
  await expect(initialize(creator, sessionKey, "alias-session")).resolves.toEqual(
    initialized(sessionKey, "alias-session"),
  );
  await expect(initialize(sibling, sessionKey, "alias-session")).resolves.toEqual(
    existingTranscript(sessionKey),
  );
  expect(registry.assertCurrent).not.toThrow();
  expect(sibling.path).toBe(options.path);
  expect(sibling.fileIdentity).toEqual(creator.fileIdentity);
  await Promise.all([creator.release(), sibling.release()]);
  await readAliasAndClose(options, sessionKey);
  await readAliasAndClose(aliased, sessionKey, () => expect(registry.assertCurrent).not.toThrow());
  const retainedValidation = getOpenClawAgentDatabaseValidationForTransfer(options);
  assert(retainedValidation);
  expect(Atomics.load(new Int32Array(retainedValidation.valid), 0)).toBe(1);
  fs.unlinkSync(options.path);
  const replacement = creatorFor(options);
  try {
    let checkedReplacementProof = false;
    await replacement.prepare(
      source((request) => {
        if (isPreparing(request, "shared-owner")) {
          checkedReplacementProof = true;
          expect(Atomics.load(new Int32Array(retainedValidation.valid), 0)).toBe(0);
          expect(getOpenClawAgentDatabaseValidationForTransfer(options)).toBeUndefined();
        }
      }),
    );
    expect(checkedReplacementProof).toBe(true);
    expect(registry.assertCurrent).toThrow("registry changed");
    await expect(initialize(replacement, sessionKey, "alias-session")).resolves.toEqual(
      initialized(sessionKey, "alias-session"),
    );
  } finally {
    await replacement.release();
  }
});

it.each(["native-open", "child-first", "parent-first"] as const)(
  "retains executor aliases across %s maintenance borrowing",
  async (order) => {
    const { options, aliased } = aliasedFixture();
    if (order === "native-open") {
      openOpenClawAgentDatabase(options);
    }
    const parent = createOpenClawDatabaseMaintenanceScope();
    const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
    const creator =
      order === "parent-first"
        ? parent.run(() => capture(options))
        : child.run(() => capture(aliased));
    const borrower =
      order === "parent-first"
        ? child.run(() => capture(aliased))
        : parent.run(() => capture(options));
    const parentBorrower = order === "parent-first" ? creator : borrower;
    const childBorrower = order === "parent-first" ? borrower : creator;
    try {
      if (order !== "native-open") {
        await parent.run(() => creator.prepare(source()));
      }
      const identity = parentBorrower.fileIdentity;
      if (order !== "native-open") {
        expect(identity).toBeDefined();
        await childBorrower.release();
      }
      await child.close();
      expect(() => parentBorrower.assertCurrent()).not.toThrow();
      if (order !== "native-open") {
        await expect(
          parent.run(() =>
            initialize(parentBorrower, "agent:main:maintenance-borrow", "retained-session"),
          ),
        ).resolves.toEqual(initialized("agent:main:maintenance-borrow", "retained-session"));
        expect(parentBorrower.fileIdentity).toEqual(identity);
      }
      await parent.close();
      expect(() => parentBorrower.assertCurrent()).toThrow(/closed/);
    } finally {
      await Promise.allSettled([
        creator.release(),
        borrower.release(),
        child.close(),
        parent.close(),
      ]);
    }
  },
);

it.each(["missing", "schema-missing"] as const)(
  "joins concurrent creators of the same originally observed %s store",
  async (kind) => {
    const options = fixture();
    if (kind === "schema-missing") {
      emptyStore(options);
    }
    const observations = Array.from({ length: 15 }, () =>
      readDatabasePathIdentitySync(options.path),
    );
    const executions: ReturnType<typeof capture>[] = [];
    const create = async (observed: (typeof observations)[number]) => {
      const execution = creatorFor(options, observed);
      executions.push(execution);
      await execution.prepare(source());
      return execution.captureGenerationClaim();
    };
    await using _ = onExit(() => releaseAll(...executions));
    const results = await Promise.allSettled(observations.map(create));
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const claims = executions.map((execution) => execution.captureGenerationClaim());
    expect(new Set(claims.map((claim) => claim.incarnation)).size).toBe(1);
    expect(new Set(claims.map((claim) => claim.identity)).size).toBe(1);
    const firstObservation = observations[0];
    const firstClaim = claims[0];
    assert(firstObservation);
    assert(firstClaim);
    const late = await create(firstObservation);
    expect(late.incarnation).toBe(firstClaim.incarnation);
    expect(late.identity).toBe(firstClaim.identity);
    expect(() =>
      capture({ ...options, agentId: "other" }, { expectedCreationIdentity: firstObservation }),
    ).toThrow(/requested agent other/);
    expect(() =>
      capture({ ...options, env: fixture().env }, { expectedCreationIdentity: firstObservation }),
    ).toThrow(/another shared-state database/);
    await Promise.all(
      executions.map(async (execution, index) => {
        const sessionKey = `agent:main:concurrent-${index}`;
        const sessionId = `concurrent-session-${index}`;
        await expect(initialize(execution, sessionKey, sessionId)).resolves.toEqual(
          initialized(sessionKey, sessionId),
        );
      }),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "rejects an absent observation after the winning creator's file is replaced",
  async () => {
    const options = fixture();
    const observed = readDatabasePathIdentitySync(options.path);
    const creator = creatorFor(options, observed);
    const retainedPath = `${options.path}.retained`;
    await using _ = onExit(() => creator.release());
    await creator.prepare(source());
    fs.renameSync(options.path, retainedPath);
    try {
      fs.writeFileSync(options.path, "replacement target");
      expect(() => creatorFor(options, observed)).toThrow(/identity changed/);
    } finally {
      fs.unlinkSync(options.path);
      fs.renameSync(retainedPath, options.path);
    }
  },
);

it("keeps the owner's absent target when a later creator observes an unexpected file", async () => {
  const options = fixture();
  const creator = creatorFor(options);
  emptyStore(options);
  const later = creatorFor(options);
  await using _ = onExit(() => releaseAll(creator, later));
  await expect(later.prepare(source())).rejects.toThrow(/changed before creating open/);
  expect(fs.readFileSync(options.path)).toHaveLength(0);
});

it("retains the first creator's file witness on a preexisting execution owner", async () => {
  const options = fixture();
  emptyStore(options);
  const ordinary = capture(options);
  const creator = creatorFor(options);
  fs.renameSync(options.path, `${options.path}.original`);
  fs.writeFileSync(options.path, "");
  const later = creatorFor(options);
  await using _ = onExit(() => releaseAll(ordinary, creator, later));
  await expect(later.prepare(source())).rejects.toThrow(
    /identity changed|captured creating reference/,
  );
  expect(fs.readFileSync(options.path)).toHaveLength(0);
});

it("prepares its originally missing store and records native birth without changing identity", async () => {
  const options = fixture();
  const observed = readDatabasePathIdentitySync(options.path);
  const execution = creatorFor(options, observed);
  await using _ = onExit(() => execution.release());
  expect(execution.fileIdentity).toBeUndefined();
  await execution.prepare(source());
  const physical = readDatabasePathIdentitySync(options.path);
  expect(physical.canonicalPath).toBe(observed.canonicalPath);
  expect(execution.fileIdentity).toMatchObject({
    kind: "file",
    physicalIdentity: physical.key.slice("file:".length),
    birthtime: physical.birthtime,
  });
  await expect(execution.runExisting(source(), async () => "retained")).resolves.toBe("retained");
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
  const warm = capture({
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
      return capture({
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
    capture(options, {
      expectedIdentity: {
        kind: "file",
        physicalIdentity: physical.key.slice("file:".length),
        nativeLocation: physical.canonicalPath,
        birthtime: (fs.statSync(options.path, { bigint: true }).birthtimeNs + 1n).toString(),
      },
    }),
  ).toThrow(/identity|physical file/);
});

it.each(["fresh root", "existing agent"] as const)(
  "preserves a relative registration through native opening, relocation, and removal (%s alias)",
  async (layout) => {
    const options = fixture();
    const alias = path.join(tempDirs.make("agent-registry-alias-"), "state");
    directoryAlias(options.env.OPENCLAW_STATE_DIR, alias);
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
      directoryAlias(tempDirs.make("agent-registry-external-"), path.dirname(options.path));
    }
    if (layout !== "fresh root") {
      openOpenClawAgentDatabase(aliased);
      await closeOpenClawAgentDatabasesAsync();
    }
    const state = openOpenClawStateDatabase({ env: aliased.env });
    const registrations = () => state.db.prepare("SELECT path FROM agent_databases").all();
    expect(registrations()).toEqual(layout === "fresh root" ? [] : [{ path: relative }]);
    const execution = capture(aliased);
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

it.each(["missing", "schema-missing"] as const)(
  "creates a %s target through its already captured logical owner",
  async (kind) => {
    const options = fixture();
    if (kind === "schema-missing") {
      emptyStore(options);
    }
    const observed = readDatabasePathIdentitySync(options.path);
    const sibling = capture(options);
    let creator: Execution | undefined = undefined;
    await using _ = onExit(() => releaseAll(creator, sibling));
    creator = creatorFor(options, observed);
    if (kind === "schema-missing") {
      await expect(sibling.prepare(source())).rejects.toThrow(/captured creating reference/);
      expect(fs.readFileSync(options.path)).toHaveLength(0);
    }
    await creator.prepare(source());
    await expect(sibling.prepare(source())).resolves.toBeUndefined();
    expect(creator.fileIdentity).toMatchObject({ kind: "file" });
    expect(sibling.fileIdentity).toEqual(creator.fileIdentity);
  },
);

it.each([
  { name: "replacement", write: replaceSessionEntry },
  { name: "upsert", write: upsertSessionEntryCore },
])(
  "allows the first session $name while an ordinary owner is retained",
  async ({ name, write }) => {
    const options = fixture();
    const sibling = capture(options);
    const sessionKey = "agent:main:first-entry";
    const entry = { sessionId: "first-session", updatedAt: 1 };
    await using _ = onExit(() => sibling.release());
    expect(fs.existsSync(options.path)).toBe(false);
    const writeStartedAt = Date.now();
    const written = await write(
      { agentId: options.agentId, env: options.env, storePath: options.path, sessionKey },
      entry,
    );
    const writeFinishedAt = Date.now();
    assert(written);
    expect(written.sessionId).toBe(entry.sessionId);
    if (name === "replacement") {
      expect(written).toEqual({ ...entry, delivery: { kind: "none" } });
    } else {
      expect(written.updatedAt).toBeGreaterThanOrEqual(writeStartedAt);
      expect(written.updatedAt).toBeLessThanOrEqual(writeFinishedAt);
    }
    const read = await sibling.runExisting(source(), (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: [sessionKey] } }),
    );
    assert(read);
    expect(read.entries).toEqual([{ sessionKey, entry: written }]);
  },
);

it.each(["unused", "refused"] as const)(
  "releases the %s creation reservation while a sibling remains",
  async (state) => {
    const options = fixture();
    const observed = readDatabasePathIdentitySync(options.path);
    const creator = creatorFor(options, observed);
    const joining = state === "unused" ? creatorFor(options, observed) : undefined;
    const sibling = capture(options);
    await using _ = onExit(() => releaseAll(creator, joining, sibling));
    if (state === "unused") {
      await creator.release();
      await expect(sibling.prepare(source())).rejects.toThrow(/captured creating reference/);
      assert(joining);
      await joining.release();
    } else {
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
      } finally {
        admit.mockRestore();
      }
    }
    expect(readDatabasePathIdentitySync(options.path)).toEqual(observed);
    if (state === "refused") {
      await creator.release();
    }
    await sibling.prepare(source());
    expect(sibling.fileIdentity).toMatchObject({ kind: "file" });
    await expect(sibling.runExisting(source(), async () => "prepared")).resolves.toBe("prepared");
  },
);

it("joins native creating admission before releasing its original reservation", async () => {
  const options = fixture();
  const creator = creatorFor(options);
  const sibling = capture(options);
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

it("retains a creator that joins while a refused generation closes", async () => {
  const options = fixture();
  const observed = readDatabasePathIdentitySync(options.path);
  const creator = creatorFor(options, observed);
  const executions = [creator];
  const refusal = new Error("Creation source ended before opening");
  const revoked = source();
  revoked.assertCurrent = () => {
    throw refusal;
  };
  await using _ = onExit(() => releaseAll(...executions));
  await expect(creator.prepare(revoked)).rejects.toBe(refusal);
  const releasing = creator.release();
  // Release enters native cleanup at its first continuation; borrow before close settles.
  await Promise.resolve();
  const joining = creatorFor(options, observed);
  executions.push(joining);
  await releasing;
  const later = creatorFor(options, observed);
  executions.push(later);
  await Promise.all([joining.prepare(source()), later.prepare(source())]);
  expect(joining.captureGenerationClaim().incarnation).toBe(
    later.captureGenerationClaim().incarnation,
  );
});

it("keeps another captured borrower live when the initiating caller is revoked during native open", async () => {
  const options = fixture();
  openOpenClawAgentDatabase(options);
  await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  const physical = readDatabasePathIdentitySync(options.path);
  expect(physical.key).toMatch(/^file:/);
  const rejected = capture(options);
  const retained = capture(options, {
    expectedIdentity: {
      kind: "file",
      physicalIdentity: physical.key.slice("file:".length),
      birthtime: physical.birthtime,
      nativeLocation: physical.canonicalPath,
    },
  });
  const refusal = new Error("Original caller revoked at native open admission");
  let current = true;
  let reachedNativeOpen = false;
  const observed = probe.admission(workerAdmission, (request, grant, admit) => {
    if (
      request.stage === "open" &&
      isRecord(request.facts) &&
      request.facts.databasePath === options.path
    ) {
      reachedNativeOpen = true;
      current = false;
    }
    admit(request, grant);
  });
  using observation = { [Symbol.dispose]: () => observed.mockRestore() };
  void observation;
  const revoked = source();
  revoked.assertCurrent = () => {
    if (!current) {
      throw refusal;
    }
  };
  await using _ = onExit(() => releaseAll(rejected, retained));
  await expect(rejected.runExisting(revoked, async () => "not admitted")).rejects.toThrow(refusal);
  expect(reachedNativeOpen).toBe(true);
  expect(() => retained.assertCurrent()).not.toThrow();
  await expect(
    initialize(retained, "agent:main:after-open-refusal", "retained-borrower"),
  ).resolves.toEqual(initialized("agent:main:after-open-refusal", "retained-borrower"));
  expect(readDatabasePathIdentitySync(options.path)).toEqual(physical);
});

it("rechecks source authority after registration notification before authorizing native open", async () => {
  const options = fixture();
  readOpenClawAgentDatabaseRegistryToken({ env: options.env });
  const execution = capture(options);
  const revoked = new Error("Creation source revoked by its registry notification");
  let current = true;
  const requestSource = source();
  requestSource.assertCurrent = () => {
    if (!current) {
      throw revoked;
    }
  };
  requestSource.onRegistryChange = () => {
    current = false;
  };
  await using _ = onExit(() => execution.release());
  await expect(execution.prepare(requestSource)).rejects.toThrow(revoked);
  expect(fs.existsSync(options.path)).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "finishes an admitted read on its retained file and rejects replacement at the next command",
  async () => {
    const options = fixture();
    const retainedPath = `${options.path}.retained`;
    const execution = capture(options);
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
    const readEntry = (request = source()) =>
      execution.runExisting(request, (scope) =>
        scope.execute({
          type: "session.entry.read",
          input: { sessionKeys: ["agent:main:missing"] },
        }),
      );
    try {
      await execution.prepare(source());
      await expect(readEntry(requestSource)).resolves.toMatchObject({ entries: [] });
      expect(replaced).toBe(true);
      await expect(readEntry()).rejects.toThrow(/identity changed/);
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
  const creator = creatorFor(options);
  const sibling = capture(options);
  let replaced = false;
  await using _ = onExit(() => releaseAll(creator, sibling));
  await expect(sibling.prepare(source())).rejects.toThrow(/captured creating reference/);
  expect(fs.existsSync(options.path)).toBe(false);
  await expect(
    creator.prepare(
      source((request) => {
        if (!replaced && isPreparing(request, "shared-owner")) {
          emptyStore(options);
          replaced = true;
        }
      }),
    ),
  ).rejects.toThrow(/changed before creating open/);
  expect(replaced).toBe(true);
  expect(fs.readFileSync(options.path)).toHaveLength(0);
});

it.each(["missing", "stale"] as const)(
  "refuses %s original FILE birthtime before writable preparation",
  async (kind) => {
    const options = fixture();
    emptyStore(options);
    const observed = readDatabasePathIdentitySync(options.path);
    const birthtime = fs.statSync(options.path, { bigint: true }).birthtimeNs;
    expect(() =>
      capture(options, {
        expectedCreationIdentity: {
          ...observed,
          birthtime: kind === "missing" ? undefined : (birthtime + 1n).toString(),
        },
      }),
    ).toThrow(/originally observed target/);
    expect(fs.readFileSync(options.path)).toHaveLength(0);
  },
);
