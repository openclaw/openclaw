import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
  sqliteMethods,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { resolveHeartbeatSession } from "../../infra/heartbeat-runner-session.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import * as registryListing from "../../state/openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import {
  loadSessionEntry,
  patchSessionEntryTarget,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { loadExactSessionEntryReadOnly } from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope, SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import {
  readSessionEntryInWorker,
  readSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoresInWorker,
} from "./session-entry-read-runtime.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});

function storedScope(storePath: string, scope: Partial<SessionAccessScope> = {}) {
  return { agentId: "ops", env: state.env, storePath, sessionKey: "global", ...scope };
}

function holdExecution(
  stage:
    | "while-queued"
    | "before-open"
    | "after-row"
    | "after-release"
    | "after-discovery-cleanup"
    | "reply",
  shouldHold: (execution: OpenClawAgentDatabaseExecution) => boolean = () => true,
  once = stage === "reply",
) {
  const gate = {
    entered: createDeferredCore(),
    release: createDeferredCore(),
    armed: stage !== "reply",
    executionReleased: false,
    restore: () => intercept.mockRestore(),
  };
  const hold = async (execution: OpenClawAgentDatabaseExecution) => {
    if (gate.armed && shouldHold(execution)) {
      gate.armed = !once;
      gate.entered.resolve();
      await gate.release.promise;
    }
  };
  const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
  const intercept = vi
    .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const execution = capture(...args);
      if (stage === "while-queued") {
        gate.entered.resolve();
      }
      const overrides: Partial<OpenClawAgentDatabaseExecution> = {};
      if (stage === "before-open") {
        overrides.prepare = async (source) => {
          await hold(execution);
          await execution.prepare(source);
        };
      } else if (stage === "after-row" || stage === "reply") {
        overrides.runExisting = (source, operation, options) =>
          execution.runExisting(
            source,
            async (worker) => {
              const execute: typeof worker.execute = async (command, requestOptions) => {
                const result = await worker.execute(command, requestOptions);
                await hold(execution);
                return result;
              };
              const result = await operation(stage === "reply" ? { execute } : worker);
              if (stage === "after-row") {
                await hold(execution);
              }
              return result;
            },
            options,
          );
      } else if (stage === "after-release" || stage === "after-discovery-cleanup") {
        overrides.release = async () => {
          await execution.release();
          gate.executionReleased = true;
          if (stage === "after-release") {
            await hold(execution);
          }
        };
      }
      return { ...execution, ...overrides };
    });
  return gate;
}

function interceptRegistryRead(onError: (error: unknown) => void) {
  const prepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
  return vi
    .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
    .mockImplementation((...args) => {
      const snapshot = prepare(...args);
      return {
        ...snapshot,
        assertCurrent() {
          try {
            snapshot.assertCurrent();
          } catch (error) {
            onError(error);
            throw error;
          }
        },
      };
    });
}

async function readFirstSession(
  kind: "read" | "admission",
  scope: SessionAccessScope,
  assertCurrent?: () => void,
) {
  if (kind === "read") {
    return readSessionEntryInWorker(scope, assertCurrent);
  }
  const loaded = await loadSessionEntryForAdmission(scope, { assertCurrent });
  try {
    loaded.databaseClaim.assertCurrent();
    return loaded.entry;
  } finally {
    await loaded.databaseClaim.release();
  }
}

it("shares cold database admission with an immediate heartbeat", async () => {
  const agentId = "heartbeat-admission";
  const scope = storedScope(state.sessionsDir(agentId) + "/sessions.json", {
    agentId,
    sessionKey: `agent:${agentId}:hook`,
  });
  const gate = holdExecution("before-open", (execution) => execution.agentId === agentId, true);
  const first = readSessionEntryInWorker(scope);
  let heartbeat: Promise<Awaited<ReturnType<typeof resolveHeartbeatSession>>> | undefined;
  try {
    await awaitGateBeforeSettlement(gate.entered.promise, first, "Hook admission was not held");
    heartbeat = Promise.resolve(
      resolveHeartbeatSession(
        { session: { store: scope.storePath } },
        agentId,
        undefined,
        undefined,
        state.env,
      ),
    );
    void heartbeat.catch(() => {});
    gate.release.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(heartbeat).resolves.toMatchObject({ entry: undefined });
  } finally {
    gate.release.resolve();
    await Promise.allSettled([first, heartbeat]);
    gate.restore();
  }
});

it("preserves heartbeat entries and SQLite creation without materializing the JSON locator", async () => {
  for (const reader of ["native", "worker"] as const) {
    const agentId = `heartbeat-${reader}`;
    const scope = storedScope(state.sessionsDir(agentId) + "/sessions.json", {
      agentId,
      sessionKey: `agent:${agentId}:main`,
    });
    const databasePath = resolveOpenClawAgentSqlitePath(scope);
    const cfg = { session: { store: scope.storePath } };
    const expected = {
      sessionKey: scope.sessionKey,
      storePath: scope.storePath,
      suppressOriginatingContext: false,
    };
    expect(fs.existsSync(databasePath)).toBe(false);
    if (reader === "native") {
      expect(loadSessionEntry(scope)).toBeUndefined();
    } else {
      await expect(
        resolveHeartbeatSession(cfg, agentId, undefined, undefined, state.env),
      ).resolves.toEqual({ ...expected, entry: undefined });
    }
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(fs.existsSync(scope.storePath)).toBe(false);
    const entry = {
      sessionId: `heartbeat-${reader}-session`,
      updatedAt: 123,
      lastChannel: "telegram",
      lastTo: "group:operations",
      deliveryContext: { channel: "telegram", to: "group:operations", threadId: 42 },
      heartbeatIsolatedBaseSessionKey: scope.sessionKey,
    };
    replaceSessionEntrySync(scope, entry);
    const native = loadSessionEntry(scope);
    expect(native).toMatchObject(entry);
    await expect(
      resolveHeartbeatSession(cfg, agentId, undefined, undefined, state.env),
    ).resolves.toEqual({ ...expected, entry: native });
    expect(fs.existsSync(scope.storePath)).toBe(false);
  }
});

it("refuses a successor registration instead of extending the captured pending join", async () => {
  const agentId = "bounded-registration";
  const scope = storedScope(state.statePath("pending-registration", agentId, "sessions.json"), {
    agentId,
    defaultAgentId: agentId,
    sessionKey: `agent:${agentId}:missing`,
  });
  const agentPath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(scope)));
  const capture = () =>
    registryListing.captureOpenClawAgentDatabaseRegistration({
      agentId,
      agentPath,
      admission: captureOpenClawStateWorkerContext({ env: state.env }).admission,
    });
  const first = capture();
  const successor = capture();
  const repeatedJoin = createDeferredCore<Error>();
  let joined = false;
  const discovery = interceptRegistryRead((error) => {
    if (error instanceof registryListing.AgentDatabaseRegistryPendingError) {
      const settle = error.waitForSettlement;
      vi.spyOn(error, "waitForSettlement").mockImplementation(async () => {
        if (joined) {
          repeatedJoin.resolve(new Error("Discovery joined the successor registration"));
          return settle();
        }
        joined = true;
        first.finish();
        await settle();
        successor.begin();
      });
    }
  });
  first.begin();
  const reading = readSessionEntryInWorker(scope).catch((error: unknown) => error);
  try {
    await expect(Promise.race([reading, repeatedJoin.promise])).resolves.toBeInstanceOf(
      registryListing.AgentDatabaseRegistryPendingError,
    );
    expect(joined).toBe(true);
  } finally {
    first.finish();
    successor.finish();
    await reading;
    discovery.mockRestore();
  }
});

it.each(
  (["read", "admission"] as const).flatMap((kind) =>
    [false, true].map((revoked) => ({ kind, revoked })),
  ),
)(
  "waits for pending first registration before a fresh $kind (caller revoked=$revoked)",
  async ({ kind, revoked }) => {
    const agentId = `pending-${kind}-${revoked}`;
    const scope = storedScope(state.statePath("pending-registration", agentId, "sessions.json"), {
      agentId,
      defaultAgentId: agentId,
      sessionKey: `agent:${agentId}:missing`,
    });
    const registered = createDeferredCore();
    const release = createDeferredCore();
    const blocked = createDeferredCore();
    const capture = registryListing.captureOpenClawAgentDatabaseRegistration;
    let held = false;
    const registration = vi
      .spyOn(registryListing, "captureOpenClawAgentDatabaseRegistration")
      .mockImplementation((params) => {
        const owned = capture(params);
        if (params.agentId !== agentId) {
          return owned;
        }
        let started = false;
        let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
        return {
          ...owned,
          begin() {
            owned.begin();
            started = true;
          },
          get nativeSettlement() {
            return settlement;
          },
          set nativeSettlement(value: Promise<SqliteWorkerOperationSettlement> | undefined) {
            settlement = value?.then(async (outcome) => {
              if (started && !held) {
                held = true;
                registered.resolve();
                await release.promise;
              }
              return outcome;
            });
          },
        };
      });
    const first = readSessionEntryInWorker(scope);
    let callerCurrent = true;
    const assertCallerCurrent = () => {
      if (!callerCurrent) {
        throw new Error("Pending caller was revoked");
      }
    };
    let second: Promise<unknown> | undefined;
    let discovery: ReturnType<typeof interceptRegistryRead> | undefined;
    try {
      await awaitGateBeforeSettlement(registered.promise, first, "First registration was not held");
      discovery = interceptRegistryRead((error) => {
        if (error instanceof registryListing.AgentDatabaseRegistryChangedError) {
          blocked.resolve();
        }
      });
      second = readFirstSession(kind, scope, assertCallerCurrent);
      void second.catch(() => {});
      await awaitGateBeforeSettlement(
        blocked.promise,
        second,
        "Second discovery missed registration",
      );
      callerCurrent = !revoked;
      release.resolve();
      await expect(first).resolves.toBeUndefined();
      if (revoked) {
        await expect(second).rejects.toThrow("Pending caller was revoked");
      } else {
        await expect(second).resolves.toBeUndefined();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      discovery?.mockRestore();
      registration.mockRestore();
    }
  },
);

it.each(["read", "admission"] as const)(
  "joins concurrent first %s requests through the queued database owner",
  async (kind) => {
    const agentId = `first-${kind}`;
    const scope = { agentId, env: state.env, sessionKey: `agent:${agentId}:missing` };
    const databasePath = resolveOpenClawAgentSqlitePath(scope);
    expect(fs.existsSync(databasePath)).toBe(false);
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => readFirstSession(kind, scope)),
    );
    expect(results).toEqual(
      Array.from({ length: 15 }, () => ({ status: "fulfilled", value: undefined })),
    );
    expect(fs.existsSync(databasePath)).toBe(true);
  },
);

it("preserves logical and physical owners without parent SQLite calls", async () => {
  const canonical = state.sessionsDir("ops") + "/sessions.json";
  const customScope = storedScope(state.statePath("logical-read", "sessions.json"));
  const unregistered = storedScope(state.statePath("unregistered", "sessions.json"));
  const sharedPhysical = { ...customScope, storePath: state.statePath("shared.sqlite") };
  const cases: Array<[sessionId: string, scope: SessionAccessScope, writerAgent?: string]> = [
    ["unregistered", unregistered],
    ["global", customScope],
    ["unknown", { ...customScope, sessionKey: "unknown" }],
    ["main", { ...customScope, sessionKey: "main" }],
    ["opaque", { ...customScope, sessionKey: "agent:ops:matrix:group:!Room:example.org" }],
    ["inferred", { storePath: canonical, sessionKey: "topic" }],
    [
      "configured-default",
      {
        defaultAgentId: "ops",
        storePath: state.statePath("default-owner", "sessions.json"),
        sessionKey: "global",
      },
    ],
    ["shared-physical-main", sharedPhysical, "main"],
  ];
  for (const [sessionId, scope, writerAgent = "ops"] of cases) {
    replaceSessionEntrySync(
      { ...scope, agentId: writerAgent, env: state.env },
      {
        sessionId,
        updatedAt: 1,
        pendingFinalDelivery: {
          kind: "replayable",
          createdAt: 1,
          text: "retained final",
          intentId: sessionId,
        },
      },
    );
  }
  unregisterOpenClawAgentDatabase({
    agentId: "ops",
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(unregistered))),
    env: state.env,
  });
  await closeOpenClawAgentDatabasesAsync();
  const observer = observeParentSqlite();
  try {
    const calibration = openNodeSqliteDatabase(":memory:");
    calibration.exec("CREATE TABLE calibration (value INTEGER)");
    calibration.prepare("INSERT INTO calibration VALUES (?)").run(7);
    const query = calibration.prepare("SELECT value FROM calibration");
    expect(query.get()).toEqual({ value: 7 });
    expect(query.all()).toEqual([{ value: 7 }]);
    expect([...query.iterate()]).toEqual([{ value: 7 }]);
    calibration.close();
    sqliteMethods.forEach((method) => expect(observer.counts[method], method).toBeGreaterThan(0));
    observer.reset();
    for (const [sessionId, scope] of cases) {
      expect(await readSessionEntryInWorker({ ...scope, env: state.env })).toMatchObject({
        sessionId,
        pendingFinalDelivery: { text: "retained final", intentId: sessionId },
      });
    }
    expect(observer.counts).toEqual(emptySqliteCounts());
  } finally {
    observer.restore();
  }
});

it.each(["before-consume", "after-consume"])(
  "retains a read across an unrelated registry change %s",
  async (stage) => {
    const scope = storedScope(state.statePath("consumed-read", stage, "sessions.json"));
    replaceSessionEntrySync(scope, { sessionId: "consumed-session", updatedAt: 1 });
    const unrelatedPath = openOpenClawAgentDatabase({ agentId: "unrelated", env: state.env }).path;
    await closeOpenClawAgentDatabasesAsync();
    let registryChange: Promise<void> | undefined;
    let consumed = 0;
    const changeRegistry = () =>
      unregisterOpenClawAgentDatabase({
        agentId: "unrelated",
        path: unrelatedPath,
        env: state.env,
      });
    const reading = withSessionEntriesFromStoresInWorker(
      [{ ...scope, sessionKeys: [scope.sessionKey] }],
      ([read]) => {
        if (stage === "before-consume") {
          changeRegistry();
        }
        read!.assertCurrent();
        expect(read!.result.entries[0]?.entry.sessionId).toBe("consumed-session");
        consumed++;
        if (stage === "after-consume") {
          registryChange = Promise.resolve().then(changeRegistry);
        }
        return "consumed";
      },
    ).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      const result = await reading;
      expect(consumed).toBe(1);
      expect(result).toEqual({ value: "consumed", error: undefined });
    } finally {
      await registryChange;
    }
  },
);

it("retains the captured relative locator and environment across worker preparation", async () => {
  const originalCwd = process.cwd();
  const storePath = state.statePath("relative", "sessions.json");
  const scope = storedScope(storePath, { env: { ...state.env } });
  replaceSessionEntrySync(scope, { sessionId: "captured-location", updatedAt: 1 });
  const reading = readSessionEntryInWorker({
    ...scope,
    storePath: path.relative(originalCwd, scope.storePath),
  });
  try {
    scope.env.OPENCLAW_STATE_DIR = state.statePath("later-environment");
    process.chdir(state.stateDir);
    await expect(reading).resolves.toMatchObject({ sessionId: "captured-location" });
  } finally {
    process.chdir(originalCwd);
    await reading;
  }
});

it("keeps writable schema-repair admission for a logical read", async () => {
  const scope = { agentId: "creating", env: state.env, sessionKey: "global" };
  const database = openOpenClawAgentDatabase(scope);
  database.db.exec("DROP INDEX idx_agent_session_nodes_label");
  await closeOpenClawAgentDatabasesAsync();
  await expect(readSessionEntryInWorker(scope)).resolves.toBeUndefined();
  const inspect = openNodeSqliteDatabase(database.path, { readOnly: true });
  try {
    expect(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("idx_agent_session_nodes_label"),
    ).toEqual({ name: "idx_agent_session_nodes_label" });
  } finally {
    inspect.close();
  }
});

it("refuses malformed folded candidate state while retaining the healthy requested row", async () => {
  const scope = {
    agentId: "aliases",
    env: state.env,
    sessionKey: "agent:aliases:matrix:group:!Room:example.org",
  };
  const folded = "agent:aliases:matrix:group:!room:example.org";
  replaceSessionEntrySync(scope, { sessionId: "healthy", updatedAt: 1 });
  replaceSessionEntrySync({ ...scope, sessionKey: folded }, { sessionId: "broken", updatedAt: 1 });
  expect(loadExactSessionEntryReadOnly(scope)?.entry.sessionId).toBe("healthy");
  const database = openOpenClawAgentDatabase(scope);
  const { claim, reader } = await admitCohort(scope);
  const read = () =>
    reader.withRead(
      { sessionKeys: [scope.sessionKey] },
      () => {},
      (cohort) =>
        cohort.entries.map(({ sessionKey, entry }) => ({ sessionKey, sessionId: entry.sessionId })),
    );
  try {
    await expect(read()).resolves.toEqual([{ sessionKey: scope.sessionKey, sessionId: "healthy" }]);
    const foreign = openNodeSqliteDatabase(database.path);
    try {
      expect(
        foreign
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run("{", folded).changes,
      ).toBe(1);
    } finally {
      foreign.close();
    }
    // The selected row is unchanged; this phase must still refuse its corrupted folded guard.
    await expect(read()).rejects.toMatchObject({
      code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
    });
    await expect(Promise.resolve().then(() => loadSessionEntry(scope))).rejects.toMatchObject({
      code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
    });
    await expect(readSessionEntryInWorker(scope)).rejects.toMatchObject({
      code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
    });
  } finally {
    await claim.release();
  }
});

it.each([
  { stage: "while-queued", change: "registry", registration: "changed" },
  { stage: "while-queued", change: "file", registration: "changed" },
  { stage: "while-queued", change: "file", registration: "unchanged" },
  { stage: "while-queued", change: "caller", registration: "changed" },
  { stage: "before-open", change: "registry", registration: "changed" },
  { stage: "after-row", change: "registry", registration: "changed" },
  { stage: "after-release", change: "registry", registration: "changed" },
  { stage: "after-discovery-cleanup", change: "registry", registration: "changed" },
] as const)(
  "refuses $change replacement $stage ($registration registration)",
  async ({ stage, change, registration }) => {
    const scope = storedScope(state.statePath(stage, change, registration, "sessions.json"));
    replaceSessionEntrySync(scope, { sessionId: "selected-row", updatedAt: 1 });
    const target = toDatabaseOptions(resolveSqliteScope(scope));
    if (change === "file") {
      await closeOpenClawAgentDatabasesAsync();
    }
    const gate = holdExecution(stage);
    const holdDiscoveryCleanup = async () => {
      if (stage === "after-discovery-cleanup" && gate.executionReleased) {
        gate.entered.resolve();
        await gate.release.promise;
      }
    };
    const closeResources = targetDiscoveryLane.pool.closeResources.bind(targetDiscoveryLane.pool);
    const rotate = targetDiscoveryLane.pool.rotate.bind(targetDiscoveryLane.pool);
    const closeIntercept = vi
      .spyOn(targetDiscoveryLane.pool, "closeResources")
      .mockImplementation(async (key) => {
        await closeResources(key);
        await holdDiscoveryCleanup();
      });
    const rotateIntercept = vi
      .spyOn(targetDiscoveryLane.pool, "rotate")
      .mockImplementation(async () => {
        await rotate();
        await holdDiscoveryCleanup();
      });
    const writerEntered = createDeferredCore();
    const priorWriter =
      stage === "while-queued"
        ? runOpenClawAgentWorkerWrite(target, async () => {
            writerEntered.resolve();
            await gate.release.promise;
          })
        : undefined;
    if (priorWriter) {
      await writerEntered.promise;
    }
    let callerCurrent = true;
    const reading = readSessionEntryInWorker(scope, () => {
      if (!callerCurrent) {
        throw new Error("Captured caller was revoked");
      }
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    void reading.then((result) => {
      gate.entered.reject(
        result.error ?? new Error("Logical read completed before its held boundary"),
      );
    });
    try {
      await gate.entered.promise;
      const databasePath = resolveOpenClawAgentSqlitePath(target);
      if (change === "registry") {
        unregisterOpenClawAgentDatabase({ agentId: "ops", path: databasePath, env: state.env });
      } else if (change === "file") {
        fs.renameSync(databasePath, `${databasePath}.original`);
        fs.copyFileSync(`${databasePath}.original`, databasePath);
      } else {
        callerCurrent = false;
      }
      if (registration === "changed") {
        registerOpenClawAgentDatabase({
          agentId: change === "registry" ? "other" : "ops",
          path: databasePath,
          env: state.env,
        });
      }
      gate.release.resolve();
      const result = await reading;
      expect(result.value).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
    } finally {
      gate.release.resolve();
      await reading;
      await priorWriter;
      gate.restore();
      closeIntercept.mockRestore();
      rotateIntercept.mockRestore();
    }
  },
);

it.each(
  [undefined, "main", "other"].flatMap((agentId) =>
    ["global", "topic"].map((sessionKey) => ({ agentId, sessionKey })),
  ),
)(
  "preserves a populated incognito owner for an explicit locator ($agentId, $sessionKey)",
  async ({ agentId, sessionKey }) => {
    const owner = { agentId: `ops-memory-${agentId ?? "missing"}-${sessionKey}`, env: state.env };
    const storePath = resolveIncognitoOpenClawAgentSqlitePath(owner);
    const ownedScope = { ...owner, storePath, sessionKey };
    const entry = { sessionId: "private-ops-session", updatedAt: 1 };
    replaceSessionEntrySync(ownedScope, entry);
    const database = openOpenClawAgentDatabase({ ...owner, path: storePath });
    const scope = { env: state.env, storePath, sessionKey, agentId };
    if (agentId === undefined) {
      expect(loadSessionEntry(scope)).toMatchObject(entry);
      await expect(readSessionEntryInWorker(scope)).resolves.toMatchObject(entry);
    } else {
      const mismatch = "Explicit incognito database target does not match its agent and state root";
      expect(() => loadSessionEntry(scope)).toThrow(mismatch);
      await expect(readSessionEntryInWorker(scope)).rejects.toThrow(mismatch);
    }
    expect(fs.existsSync(storePath)).toBe(false);
    expect(openOpenClawAgentDatabase({ ...owner, path: storePath })).toBe(database);
    expect(loadSessionEntry(ownedScope)).toMatchObject(entry);
  },
);

function createCohortFixture(name: string) {
  const scope = storedScope(state.statePath("admitted-cohort", name, "sessions.json"), {
    agentId: "cohort",
    sessionKey: `agent:cohort:${name}`,
  });
  const entry = { sessionId: name, lifecycleRevision: "original", updatedAt: 1 };
  replaceSessionEntrySync(scope, entry);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  return { scope, entry, database };
}

async function admitCohort(scope: SessionAccessScope) {
  const loaded = await loadSessionEntryForAdmission(scope);
  const claim = loaded.databaseClaim;
  if (!("reader" in claim) || !claim.reader) {
    await claim.release();
    throw new Error("Expected a durable admission reader");
  }
  return { claim, reader: claim.reader };
}

it("refreshes admitted cohorts after a known write and a foreign membership commit between phases", async () => {
  const { scope, database } = createCohortFixture("fresh-phases");
  const identity = readOpenClawAgentDatabaseIdentity(database);
  addSessionMember(scope, { identityId: "original-member", addedBy: "owner", addedAt: 1 });
  const { claim, reader } = await admitCohort(scope);
  const request = { sessionKeys: [scope.sessionKey], includeMembers: true, snapshotFields: [] };
  const external = createDeferredCore();
  let following: Promise<unknown> | undefined;
  const peer = openNodeSqliteDatabase(database.path);
  const observer = observeParentSqlite();
  let escaped: (() => void) | undefined;
  try {
    await reader.withRead(
      request,
      () => {},
      (read, assertCurrent) => {
        assertCurrent();
        escaped = assertCurrent;
        expect(read.members?.[scope.sessionKey]?.map(({ identityId }) => identityId)).toEqual([
          "original-member",
        ]);
      },
    );
    expect(observer.counts).toEqual(emptySqliteCounts());
    expect(escaped).toThrow("consumption has ended");
    let readTarget: SessionEntryTargetPatchScope | undefined;
    const recordReadTarget = (target: SessionEntryTargetPatchScope) => {
      readTarget = target;
    };
    await expect(
      readSessionEntryInWorker(scope, () => {}, undefined, recordReadTarget, reader),
    ).resolves.toMatchObject({ sessionId: "fresh-phases", lifecycleRevision: "original" });
    if (!readTarget) {
      throw new Error("Writable cohort read omitted its physical target");
    }
    expect(readTarget).toMatchObject({
      agentId: scope.agentId,
      storePath: database.path,
      readSource: {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
      },
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    });
    expect(observer.counts).toEqual(emptySqliteCounts());
    following = external.promise.then(() =>
      reader.withRead(
        request,
        () => {},
        (read) => {
          expect(read.entries[0]?.entry).toMatchObject({ label: "known write" });
          expect(read.members?.[scope.sessionKey]?.map(({ identityId }) => identityId)).toEqual([
            "foreign-member",
          ]);
        },
      ),
    );
    // Completing the writer before releasing the external wait proves no FIFO is held between phases.
    await patchSessionEntryTarget(readTarget, () => ({ label: "known write" }), {
      skipMaintenance: true,
    });
    peer.prepare("DELETE FROM session_members WHERE session_key = ?").run(scope.sessionKey);
    peer
      .prepare(`INSERT INTO session_members (session_key, identity_id, added_by, added_at)
      VALUES (?, 'foreign-member', 'other-process', 2)`)
      .run(scope.sessionKey);
    observer.reset();
    external.resolve();
    await following;
    expect(observer.counts).toEqual(emptySqliteCounts());
    await expect(
      reader.withRead(
        request,
        () => {},
        async () => undefined,
      ),
    ).rejects.toThrow("consumers must remain synchronous");
    await claim.release();
    readTarget = undefined;
    await expect(
      readSessionEntryInWorker(scope, () => {}, undefined, recordReadTarget, reader),
    ).rejects.toThrow(/released|closed|revoked/iu);
    expect(readTarget).toBeUndefined();
  } finally {
    observer.restore();
    external.resolve();
    await Promise.allSettled(following ? [following] : []);
    peer.close();
    await claim.release();
  }
});

it.each(["reset", "delete", "physical replacement", "release"] as const)(
  "refuses an admitted cohort after %s without consuming stale rows",
  async (change) => {
    const { scope, entry, database } = createCohortFixture(`revoke-${change.replaceAll(" ", "-")}`);
    const { claim, reader } = await admitCohort(scope);
    const consume = vi.fn();
    try {
      if (change === "reset") {
        replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "successor" });
      } else if (change === "delete") {
        database.db
          .prepare("DELETE FROM session_nodes WHERE session_key = ?")
          .run(scope.sessionKey);
      } else if (change === "physical replacement") {
        fs.copyFileSync(database.path, `${database.path}.replacement`);
        fs.renameSync(`${database.path}.replacement`, database.path);
      } else {
        await claim.release();
      }
      await expect(
        reader.withRead({ sessionKeys: [scope.sessionKey] }, () => {}, consume),
      ).rejects.toThrow(/changed|replaced|released|closed/iu);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      await claim.release();
    }
  },
);

it.each(["native mutation", "caller revocation"] as const)(
  "rejects %s after the worker reply and before cohort consumption",
  async (change) => {
    const { scope, database } = createCohortFixture(`late-${change.replaceAll(" ", "-")}`);
    if (change === "native mutation") {
      addSessionMember(scope, { identityId: "native-member", addedBy: "owner", addedAt: 1 });
    }
    const mutateMembership = () => {
      const mutation = database.db
        .prepare("UPDATE session_members SET added_at = added_at + 1 WHERE session_key = ?")
        .run(scope.sessionKey);
      expect(mutation.changes).toBe(1);
    };
    const gate = holdExecution("reply");
    let claim: Awaited<ReturnType<typeof admitCohort>>["claim"] | undefined;
    let reading: Promise<unknown> | undefined;
    const consume = vi.fn();
    let allowed = true;
    try {
      const admitted = await admitCohort(scope);
      claim = admitted.claim;
      gate.armed = true;
      reading = admitted.reader.withRead(
        { sessionKeys: [scope.sessionKey], includeMembers: true },
        () => {
          if (!allowed) {
            throw new Error("Cohort caller was revoked");
          }
        },
        consume,
      );
      void reading.catch(() => {});
      await awaitGateBeforeSettlement(
        gate.entered.promise,
        reading,
        "Cohort settled before its reply gate",
      );
      if (change === "native mutation") {
        // The synchronous SDK can write without entering the FIFO or publishing sessionChanges.
        mutateMembership();
      } else {
        allowed = false;
      }
      gate.release.resolve();
      await expect(reading).rejects.toThrow(
        change === "native mutation" ? /changed during read/u : /caller was revoked/u,
      );
      expect(consume).not.toHaveBeenCalled();
      if (change === "native mutation") {
        const mutateDuringConsumption = vi.fn(() => {
          mutateMembership();
          return "must not escape the final witness";
        });
        await expect(
          admitted.reader.withRead(
            { sessionKeys: [scope.sessionKey], includeMembers: true },
            () => {},
            mutateDuringConsumption,
          ),
        ).rejects.toThrow("Session entry changed during read");
        expect(mutateDuringConsumption).toHaveBeenCalledOnce();
      }
    } finally {
      gate.release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      await claim?.release();
      gate.restore();
    }
  },
);

it.for(
  (["reply", "host-queued"] as const).flatMap((phase) =>
    (["release", "close"] as const).map((ending) => ({ phase, ending })),
  ),
)("joins a $phase cohort before completing $ending", async ({ phase, ending }, { signal }) => {
  const { scope, database, entry } = createCohortFixture(`${phase}-${ending}`);
  const gate = phase === "reply" ? holdExecution("reply") : undefined;
  const entered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const consume = vi.fn();
  let claim: Awaited<ReturnType<typeof admitCohort>>["claim"] | undefined;
  let writer: Promise<void> | undefined;
  let reading: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const admitted = await admitCohort(scope);
    claim = admitted.claim;
    const { reader } = admitted;
    const request = { sessionKeys: [scope.sessionKey] };
    if (gate) {
      gate.armed = true;
    } else {
      await expect(
        reader.withRead(
          request,
          () => {},
          (read) => {
            expect(read.entries[0]?.entry.sessionId).toBe(entry.sessionId);
          },
        ),
      ).resolves.toBeUndefined();
      writer = runOpenClawAgentWorkerWrite(reader.database, async () => {
        entered.resolve();
        await releaseWriter.promise;
      });
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, writer, "Host FIFO blocker did not enter"),
        signal,
      );
    }
    reading = reader.withRead(request, () => {}, consume);
    let readSettled = false;
    const markReadSettled = () => {
      readSettled = true;
    };
    void reading.then(markReadSettled, markReadSettled);
    if (gate) {
      await awaitGateBeforeSettlement(
        gate.entered.promise,
        reading,
        "Cohort settled before its reply gate",
      );
    }
    let closed = false;
    closing = (
      ending === "release"
        ? claim.release()
        : closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId)
    ).then(() => {
      if (!gate) {
        expect(readSettled).toBe(true);
      }
      closed = true;
    });
    if (!gate) {
      // Queued cancellation settles while the unrelated predecessor still holds FIFO.
      await expect(withinTest(reading, signal)).rejects.toThrow(/released|closed|revoked/iu);
    }
    await expect(reader.withRead(request, () => {}, consume)).rejects.toThrow(
      /released|closed|revoked/iu,
    );
    if (gate) {
      expect(closed).toBe(false);
      gate.release.resolve();
      await expect(reading).rejects.toThrow(/released|closed|revoked/iu);
    } else {
      releaseWriter.resolve();
      await withinTest(writer!, signal);
    }
    await withinTest(closing, signal);
    expect(closed).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  } finally {
    gate?.release.resolve();
    releaseWriter.resolve();
    await Promise.allSettled([writer, reading, closing]);
    await claim?.release();
    gate?.restore();
  }
});

it("leaves absent storage absent when a read-only phase has no admitted cohort", async () => {
  const scope = { agentId: "readonly-absent-cohort", env: state.env, sessionKey: "global" };
  const databasePath = resolveOpenClawAgentSqlitePath(scope);
  expect(fs.existsSync(databasePath)).toBe(false);
  await expect(readSessionEntryReadOnlyInWorker(scope)).resolves.toBeUndefined();
  expect(fs.existsSync(databasePath)).toBe(false);
});
