import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
  sqliteMethods,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { resolveHeartbeatSession } from "../../infra/heartbeat-runner-session.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as registryListing from "../../state/openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type {
  AgentDatabaseExecutionScope,
  AgentDatabaseRequestExecutionSource,
} from "../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { loadExactSessionEntryReadOnly } from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import {
  readSessionEntryInWorker,
  withSessionEntriesFromStoresInWorker,
} from "./session-entry-read-runtime.js";
import { historyLane } from "./session-transcript-worker-resources.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});

it("shares cold database admission with an immediate heartbeat", async () => {
  const agentId = "heartbeat-admission";
  const scope = {
    agentId,
    env: state.env,
    storePath: state.sessionsDir(agentId) + "/sessions.json",
    sessionKey: `agent:${agentId}:hook`,
  };
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
  let held = false;
  const intercept = vi
    .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const execution = capture(...args);
      return {
        ...execution,
        async prepare(source: AgentDatabaseRequestExecutionSource): Promise<void> {
          if (!held && execution.agentId === agentId) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          await execution.prepare(source);
        },
      };
    });
  const first = readSessionEntryInWorker(scope);
  let heartbeat: Promise<Awaited<ReturnType<typeof resolveHeartbeatSession>>> | undefined;
  try {
    await awaitGateBeforeSettlement(entered.promise, first, "Hook admission was not held");
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
    release.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(heartbeat).resolves.toMatchObject({ entry: undefined });
  } finally {
    release.resolve();
    await Promise.allSettled([first, heartbeat]);
    intercept.mockRestore();
  }
});

it("preserves heartbeat entries and SQLite creation without materializing the JSON locator", async () => {
  for (const reader of ["native", "worker"] as const) {
    const agentId = `heartbeat-${reader}`;
    const scope = {
      agentId,
      env: state.env,
      storePath: state.sessionsDir(agentId) + "/sessions.json",
      sessionKey: `agent:${agentId}:main`,
    };
    const databasePath = resolveOpenClawAgentSqlitePath(scope);
    const cfg = { session: { store: scope.storePath } };
    expect(fs.existsSync(databasePath)).toBe(false);
    if (reader === "native") {
      expect(loadSessionEntry(scope)).toBeUndefined();
    } else {
      await expect(
        resolveHeartbeatSession(cfg, agentId, undefined, undefined, state.env),
      ).resolves.toEqual({
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        suppressOriginatingContext: false,
        entry: undefined,
      });
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
    ).resolves.toEqual({
      sessionKey: scope.sessionKey,
      storePath: scope.storePath,
      suppressOriginatingContext: false,
      entry: native,
    });
    expect(fs.existsSync(scope.storePath)).toBe(false);
  }
});

it("refuses a successor registration instead of extending the captured pending join", async () => {
  const agentId = "bounded-registration";
  const scope = {
    agentId,
    defaultAgentId: agentId,
    env: state.env,
    storePath: state.statePath("pending-registration", agentId, "sessions.json"),
    sessionKey: `agent:${agentId}:missing`,
  };
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
  const prepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
  const discovery = vi
    .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
    .mockImplementation((...args) => {
      const snapshot = prepare(...args);
      return {
        ...snapshot,
        assertCurrent() {
          try {
            snapshot.assertCurrent();
          } catch (error) {
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
            throw error;
          }
        },
      };
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
    const scope = {
      agentId,
      defaultAgentId: agentId,
      env: state.env,
      storePath: state.statePath("pending-registration", agentId, "sessions.json"),
      sessionKey: `agent:${agentId}:missing`,
    };
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
    let restoreDiscovery: (() => void) | undefined;
    try {
      await awaitGateBeforeSettlement(registered.promise, first, "First registration was not held");
      const prepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
      const discovery = vi
        .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
        .mockImplementation((...args) => {
          const snapshot = prepare(...args);
          return {
            ...snapshot,
            assertCurrent() {
              try {
                snapshot.assertCurrent();
              } catch (error) {
                if (error instanceof registryListing.AgentDatabaseRegistryChangedError) {
                  blocked.resolve();
                }
                throw error;
              }
            },
          };
        });
      restoreDiscovery = () => discovery.mockRestore();
      second = (async () => {
        if (kind === "read") {
          return readSessionEntryInWorker(scope, assertCallerCurrent);
        }
        const loaded = await loadSessionEntryForAdmission(scope, {
          assertCurrent: assertCallerCurrent,
        });
        try {
          loaded.databaseClaim.assertCurrent();
          return loaded.entry;
        } finally {
          await loaded.databaseClaim.release();
        }
      })();
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
      restoreDiscovery?.();
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
      Array.from({ length: 15 }, async () => {
        if (kind === "read") {
          return await readSessionEntryInWorker(scope);
        }
        const loaded = await loadSessionEntryForAdmission(scope);
        try {
          loaded.databaseClaim.assertCurrent();
          return loaded.entry;
        } finally {
          await loaded.databaseClaim.release();
        }
      }),
    );
    expect(results).toEqual(
      Array.from({ length: 15 }, () => ({ status: "fulfilled", value: undefined })),
    );
    expect(fs.existsSync(databasePath)).toBe(true);
  },
);

it("preserves logical and physical owners without parent SQLite calls", async () => {
  const custom = state.statePath("logical-read", "sessions.json");
  const canonical = state.sessionsDir("ops") + "/sessions.json";
  const cases: Array<{ scope: SessionAccessScope; writerAgent: string; sessionId: string }> = [
    {
      scope: {
        agentId: "ops",
        storePath: state.statePath("unregistered", "sessions.json"),
        sessionKey: "global",
      },
      writerAgent: "ops",
      sessionId: "unregistered",
    },
    {
      scope: { agentId: "ops", storePath: custom, sessionKey: "global" },
      writerAgent: "ops",
      sessionId: "global",
    },
    {
      scope: { agentId: "ops", storePath: custom, sessionKey: "unknown" },
      writerAgent: "ops",
      sessionId: "unknown",
    },
    {
      scope: { agentId: "ops", storePath: custom, sessionKey: "main" },
      writerAgent: "ops",
      sessionId: "main",
    },
    {
      scope: {
        agentId: "ops",
        storePath: custom,
        sessionKey: "agent:ops:matrix:group:!Room:example.org",
      },
      writerAgent: "ops",
      sessionId: "opaque",
    },
    {
      scope: { storePath: canonical, sessionKey: "topic" },
      writerAgent: "ops",
      sessionId: "inferred",
    },
    {
      scope: {
        defaultAgentId: "ops",
        storePath: state.statePath("default-owner", "sessions.json"),
        sessionKey: "global",
      },
      writerAgent: "ops",
      sessionId: "configured-default",
    },
    {
      scope: { agentId: "ops", storePath: state.statePath("shared.sqlite"), sessionKey: "global" },
      writerAgent: "main",
      sessionId: "shared-physical-main",
    },
  ];
  for (const { scope, writerAgent, sessionId } of cases) {
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
  const unregistered = cases[0]!;
  const unregisteredTarget = toDatabaseOptions(
    resolveSqliteScope({ ...unregistered.scope, env: state.env }),
  );
  unregisterOpenClawAgentDatabase({
    agentId: "ops",
    path: resolveOpenClawAgentSqlitePath(unregisteredTarget),
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
    for (const { scope, sessionId } of cases) {
      expect(await readSessionEntryInWorker({ ...scope, env: state.env }, () => {})).toMatchObject({
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
    const scope = {
      agentId: "ops",
      env: state.env,
      storePath: state.statePath("consumed-read", stage, "sessions.json"),
      sessionKey: "global",
    };
    replaceSessionEntrySync(scope, { sessionId: "consumed-session", updatedAt: 1 });
    const unrelated = openOpenClawAgentDatabase({ agentId: "unrelated", env: state.env });
    const unrelatedPath = unrelated.path;
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
  const scope = { agentId: "ops", env: { ...state.env }, storePath, sessionKey: "global" };
  replaceSessionEntrySync(scope, { sessionId: "captured-location", updatedAt: 1 });
  const reading = readSessionEntryInWorker(
    { ...scope, storePath: path.relative(originalCwd, storePath) },
    () => {},
  );
  try {
    scope.env.OPENCLAW_STATE_DIR = state.statePath("later-environment");
    process.chdir(state.stateDir);
    await expect(reading).resolves.toMatchObject({ sessionId: "captured-location" });
  } finally {
    process.chdir(originalCwd);
    await reading;
  }
});

it("keeps creating and writable schema-repair admission for a logical read", async () => {
  const scope = { agentId: "creating", env: state.env, sessionKey: "global" };
  const databasePath = resolveOpenClawAgentSqlitePath(scope);
  expect(fs.existsSync(databasePath)).toBe(false);
  await expect(readSessionEntryInWorker(scope, () => {})).resolves.toBeUndefined();
  expect(fs.existsSync(databasePath)).toBe(true);
  await closeOpenClawAgentDatabasesAsync();
  const database = openOpenClawAgentDatabase(scope);
  database.db.exec("DROP INDEX idx_agent_session_nodes_label");
  await closeOpenClawAgentDatabasesAsync();
  await expect(readSessionEntryInWorker(scope, () => {})).resolves.toBeUndefined();
  const inspect = openNodeSqliteDatabase(databasePath, { readOnly: true });
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
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run("{", folded);
  await expect(Promise.resolve().then(() => loadSessionEntry(scope))).rejects.toMatchObject({
    code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
  });
  await expect(readSessionEntryInWorker(scope, () => {})).rejects.toMatchObject({
    code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
  });
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
    const scope = {
      agentId: "ops",
      env: state.env,
      storePath: state.statePath(stage, change, registration, "sessions.json"),
      sessionKey: "global",
    };
    replaceSessionEntrySync(scope, { sessionId: "selected-row", updatedAt: 1 });
    const target = toDatabaseOptions(resolveSqliteScope(scope));
    if (change === "file") {
      await closeOpenClawAgentDatabasesAsync();
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let executionReleased = false;
    const holdDiscoveryCleanup = async () => {
      if (stage === "after-discovery-cleanup" && executionReleased) {
        entered.resolve();
        await release.promise;
      }
    };
    const closeResources = historyLane.pool.closeResources.bind(historyLane.pool);
    const rotate = historyLane.pool.rotate.bind(historyLane.pool);
    const closeIntercept = vi
      .spyOn(historyLane.pool, "closeResources")
      .mockImplementation(async (key) => {
        await closeResources(key);
        await holdDiscoveryCleanup();
      });
    const rotateIntercept = vi.spyOn(historyLane.pool, "rotate").mockImplementation(async () => {
      await rotate();
      await holdDiscoveryCleanup();
    });
    const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
    const intercept = vi
      .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
      .mockImplementation((...args) => {
        const execution = capture(...args);
        if (stage === "while-queued") {
          entered.resolve();
        }
        return {
          ...execution,
          async prepare(source: AgentDatabaseRequestExecutionSource): Promise<void> {
            if (stage === "before-open") {
              entered.resolve();
              await release.promise;
            }
            await execution.prepare(source);
          },
          async runExisting<T>(
            source: AgentDatabaseRequestExecutionSource,
            operation: (worker: AgentDatabaseExecutionScope) => Promise<T>,
            options?: { retireNativeOnFailure: true },
          ): Promise<T | undefined> {
            return execution.runExisting(
              source,
              async (worker) => {
                const result = await operation(worker);
                if (stage === "after-row") {
                  entered.resolve();
                  await release.promise;
                }
                return result;
              },
              options,
            );
          },
          async release() {
            await execution.release();
            executionReleased = true;
            if (stage === "after-release") {
              entered.resolve();
              await release.promise;
            }
          },
        };
      });
    const writerEntered = createDeferredCore();
    const priorWriter =
      stage === "while-queued"
        ? runOpenClawAgentWorkerWrite(target, async () => {
            writerEntered.resolve();
            await release.promise;
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
      entered.reject(result.error ?? new Error("Logical read completed before its held boundary"));
    });
    try {
      await entered.promise;
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
      release.resolve();
      const result = await reading;
      expect(result.value).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
    } finally {
      release.resolve();
      await reading;
      await priorWriter;
      intercept.mockRestore();
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
