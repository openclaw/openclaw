import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqlite from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import * as writerQueue from "../../shared/store-writer-queue.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { resolveStateDir } from "../paths.js";
import {
  loadSessionEntry,
  onSessionIdentityMutation,
  patchSessionEntryCore,
} from "./session-accessor.js";
import {
  patchSessionEntryTarget,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { createWorkerSqliteIntegrityGate } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

const roots = createTempDirTracker();
const worker = vi.hoisted(() => ({
  gate: undefined as ReturnType<typeof createWorkerSqliteIntegrityGate> | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerSqliteIntegrity } =
    await import("./session-accessor.sqlite-integrity-counter.test-support.js");
  return {
    ...actual,
    Worker: observeWorkerSqliteIntegrity(actual.Worker, () => worker.gate),
  };
});
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realOpen = sqlite.openNodeSqliteDatabase;
let queued = vi.spyOn(writerQueue, "runQueuedStoreWrite");

beforeEach(() => {
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot({}, {});
  queued = vi.spyOn(writerQueue, "runQueuedStoreWrite");
});

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.allSettled(pending.splice(0));
  // Join the actual default-budget kicks too; this suite does not disable retention.
  let joined = -1;
  while (joined !== queued.mock.results.length) {
    joined = queued.mock.results.length;
    await Promise.allSettled(
      queued.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  if (worker.gate) {
    expect([...worker.gate.workers].every((observed) => observed.threadId === -1)).toBe(true);
    worker.gate = undefined;
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  roots.cleanup();
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function fixture(sessionKey = "agent:main:admission") {
  const root = roots.make("session-patch-admission-");
  const env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const scope = { agentId: "main", env, sessionKey };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  return { root, env, scope, database, databasePath: database.path };
}

function evictHandle(databasePath: string) {
  const database = getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: databasePath });
  if (!database) {
    throw new Error("Fixture lost its cached handle before eviction");
  }
  closeCachedOpenClawAgentDatabase(database, { eviction: true });
  expect(database.db.isOpen).toBe(false);
}

function closeCold(f: ReturnType<typeof fixture>) {
  evictHandle(f.databasePath);
  invalidateOpenClawAgentDatabaseValidation(f.databasePath);
  revokeSqliteDatabaseAdmissionsForPath(f.databasePath);
}

function nativeChecks(databasePath: string) {
  let parentChecks = 0;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname !== databasePath || options?.readOnly) {
      return database;
    }
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;" || sql === "PRAGMA integrity_check('sqlite_schema');") {
        const all = statement.all.bind(statement);
        statement.all = () => {
          parentChecks += 1;
          return all();
        };
      }
      return statement;
    };
    return database;
  });
  return () => parentChecks;
}

function holdWorkerValidation(databasePath: string) {
  const gate = createWorkerSqliteIntegrityGate(databasePath);
  worker.gate = gate;
  gate.arm();
  releases.push(gate.release);
  return { entered: { promise: gate.entered }, release: { resolve: gate.release } };
}

async function expectAdmission(
  gate: ReturnType<typeof holdWorkerValidation>,
  operation: Promise<unknown>,
) {
  const entered = await Promise.race([
    gate.entered.promise.then(() => true),
    operation.then(
      () => false,
      () => false,
    ),
  ]);
  expect(entered, "cold patch settled before a pending native admission could be observed").toBe(
    true,
  );
}

it.each(["sessions.json", "custom.json"])(
  "keeps concurrent first writes in one custom store (%s)",
  async (filename) => {
    const root = roots.make("session-patch-first-writes-");
    const env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const storePath = path.join(root, "custom-store", filename);
    const entries = ["first", "second", "third"].map((name) => ({
      sessionKey: `agent:main:${name}`,
      entry: {
        sessionId: `session-${name}`,
        updatedAt: Date.now(),
      },
    }));
    await Promise.all(
      entries.map(({ sessionKey, entry }) =>
        own(replaceSessionEntry({ env, storePath, sessionKey }, entry)),
      ),
    );
    expect(
      entries.map(({ sessionKey }) => loadSessionEntry({ env, storePath, sessionKey })?.sessionId),
    ).toEqual(entries.map(({ entry }) => entry.sessionId));
    expect(
      fs.readdirSync(path.dirname(storePath)).filter((entryName) => entryName.endsWith(".sqlite")),
    ).toHaveLength(1);
  },
);

it.each([
  ["target", "preparation"],
  ["entry", "commit"],
] as const)("keeps %s %s integrity checks off the caller thread", async (kind, phase) => {
  const f = fixture();
  if (phase === "preparation") {
    closeCold(f);
  }
  const parentChecks = nativeChecks(f.databasePath);
  const update = () => {
    if (phase === "commit") {
      closeCold(f);
    }
    return { label: "updated" };
  };
  const operation = own(
    kind === "entry"
      ? patchSessionEntryCore(f.scope, update, { skipMaintenance: true })
      : patchSessionEntryTarget(
          {
            agentId: "main",
            storePath: f.databasePath,
            target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] },
          },
          update,
          { skipMaintenance: true },
        ),
  );
  await expect(operation).resolves.toMatchObject({ sessionId: "original", label: "updated" });
  expect(loadSessionEntry(f.scope)).toMatchObject({ sessionId: "original", label: "updated" });
  expect(parentChecks()).toBe(0);
});

it.each(["worker", "native compatibility", "incognito"] as const)(
  "admits %s updater invocation through its owner",
  async (mode) => {
    const f = fixture(
      mode === "incognito" ? "agent:main:dashboard:incognito-admission" : undefined,
    );
    const native = vi.spyOn(integrity, "assertSqliteIntegrityInWorker");
    let called = false;
    const operation = own(
      patchSessionEntryCore(
        f.scope,
        () => {
          called = true;
          return { label: mode };
        },
        {
          skipMaintenance: true,
          assertCommitAllowed: mode === "native compatibility" ? () => {} : undefined,
        },
      ),
    );
    expect(called).toBe(mode !== "worker");
    await expect(operation).resolves.toMatchObject({ label: mode });
    expect(called).toBe(true);
    expect(native).not.toHaveBeenCalled();
    if (mode === "incognito") {
      expect(fs.readdirSync(f.root)).toEqual([]);
    }
  },
);

it.each([false, true])(
  "captures the queued state owner before admission (ambient=%s)",
  async (ambient) => {
    const f = fixture();
    const original = { ...f.scope, env: { ...f.env } };
    const successor = roots.make("session-patch-successor-");
    const release = createDeferred();
    releases.push(() => release.resolve());
    const blocker = own(
      runExclusiveSqliteSessionWrite(
        resolveSqliteScope(original),
        async () => {
          await release.promise;
        },
        "session.transcript.batch",
      ),
    );
    const scope = ambient ? { agentId: "main", sessionKey: original.sessionKey } : f.scope;
    const operation = own(
      patchSessionEntryCore(
        scope,
        () => {
          expect(
            getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: f.databasePath }),
          ).toBeUndefined();
          return { label: "original owner" };
        },
        { skipMaintenance: true },
      ),
    );
    if (ambient) {
      vi.stubEnv("OPENCLAW_STATE_DIR", successor);
    } else {
      f.env.OPENCLAW_STATE_DIR = successor;
    }
    evictHandle(f.databasePath);
    release.resolve();
    await blocker;
    await expect(operation).resolves.toMatchObject({
      sessionId: "original",
      label: "original owner",
    });
    expect(loadSessionEntry(original)).toMatchObject({ label: "original owner" });
    expect(fs.readdirSync(successor)).toEqual([]);
  },
);

it("keeps the physical database owner for logical rows in a shared store", async () => {
  const f = fixture();
  const storePath = path.join(f.root, "shared.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", env: f.env, path: storePath });
  const main = { ...f.scope, storePath, sessionKey: "agent:main:kept" };
  const secondary = { ...main, agentId: "secondary", sessionKey: "agent:secondary:shared" };
  replaceSessionEntrySync(main, { sessionId: "kept", updatedAt: 1 });
  replaceSessionEntrySync(secondary, { sessionId: "secondary", updatedAt: 1 });
  evictHandle(storePath);
  await expect(
    own(
      patchSessionEntryCore(
        secondary,
        () => {
          expect(
            getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: storePath }),
          ).toBeUndefined();
          return { label: "shared owner" };
        },
        { skipMaintenance: true },
      ),
    ),
  ).resolves.toMatchObject({ sessionId: "secondary", label: "shared owner" });
  expect(loadSessionEntry(main)).toMatchObject({ sessionId: "kept" });
  expect(
    openOpenClawAgentDatabase({ agentId: "main", env: f.env, path: storePath })
      .db.prepare("SELECT agent_id FROM schema_meta")
      .get(),
  ).toMatchObject({ agent_id: "main" });
  expect(
    fs.existsSync(path.join(f.root, "agents", "secondary", "agent", "openclaw-agent.sqlite")),
  ).toBe(false);
});

it("retains FIFO, caller context and publication across cold admission", async () => {
  const f = fixture();
  closeOpenClawAgentDatabaseByPath(f.databasePath);
  invalidateOpenClawAgentDatabaseValidation(f.databasePath);
  revokeSqliteDatabaseAdmissionsForPath(f.databasePath);
  const gate = holdWorkerValidation(f.databasePath);
  const contexts = new AsyncLocalStorage<string>();
  const order: string[] = [];
  const updateRelease = createDeferred();
  releases.push(() => updateRelease.resolve());
  const enteredUpdater = createDeferred();
  let holdUpdater = false;
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (mutation.kind !== "delete" && mutation.current.sessionKeys.includes(f.scope.sessionKey)) {
      order.push(`published:${mutation.current.sessionId}`);
    }
  });
  try {
    const first = own(
      contexts.run("first", () =>
        patchSessionEntryCore(
          f.scope,
          async () => {
            order.push(`update:${contexts.getStore()}`);
            enteredUpdater.resolve();
            if (holdUpdater) {
              await updateRelease.promise;
            }
            return { sessionId: "first" };
          },
          { skipMaintenance: true, onCommitted: () => order.push(`commit:${contexts.getStore()}`) },
        ),
      ),
    );
    await expectAdmission(gate, first);
    holdUpdater = true;
    const second = own(
      contexts.run("second", () =>
        patchSessionEntryCore(
          f.scope,
          (entry) => {
            order.push(`update:${contexts.getStore()}:${entry.sessionId}`);
            return { sessionId: "second" };
          },
          { skipMaintenance: true, onCommitted: () => order.push(`commit:${contexts.getStore()}`) },
        ),
      ),
    );
    expect(order).toEqual([]);
    gate.release.resolve();
    await enteredUpdater.promise;
    expect(order).toEqual(["update:first"]);
    updateRelease.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "update:first",
      "commit:first",
      "published:first",
      "update:second:first",
      "commit:second",
      "published:second",
    ]);
    expect(loadSessionEntry(f.scope)?.sessionId).toBe("second");
  } finally {
    unsubscribe();
    gate.release.resolve();
    updateRelease.resolve();
  }
});

it.each(["dispose", "physical replacement"] as const)(
  "rejects %s before updater admission and recovers the lane",
  async (mode) => {
    const f = fixture();
    closeCold(f);
    const gate = holdWorkerValidation(f.databasePath);
    const update = vi.fn(() => ({ label: "must not commit" }));
    const committed = vi.fn();
    const operation = own(
      patchSessionEntryCore(f.scope, update, { skipMaintenance: true, onCommitted: committed }),
    );
    try {
      await expectAdmission(gate, operation);
      expect(update).not.toHaveBeenCalled();
      if (mode === "dispose") {
        closeOpenClawAgentDatabaseByPath(f.databasePath);
      } else {
        const replacementPath = `${f.databasePath}.replacement`;
        fs.copyFileSync(f.databasePath, replacementPath);
        fs.renameSync(replacementPath, f.databasePath);
      }
      gate.release.resolve();
      await expect(operation).rejects.toThrow(/closed|revoked|replaced|changed/);
      expect(update).not.toHaveBeenCalled();
      expect(committed).not.toHaveBeenCalled();
      expect(loadSessionEntry(f.scope)).not.toHaveProperty("label");
      await expect(
        own(
          patchSessionEntryCore(f.scope, () => ({ label: "successor" }), { skipMaintenance: true }),
        ),
      ).resolves.toMatchObject({ label: "successor" });
    } finally {
      gate.release.resolve();
    }
  },
);

it.each(["cancel", "revoke"] as const)(
  "rechecks %s authority after cold commit admission",
  async (mode) => {
    const f = fixture();
    const gate = holdWorkerValidation(f.databasePath);
    let allowed = true;
    const revoked = new Error("authority revoked during commit admission");
    const committed = vi.fn();
    const operation = own(
      patchSessionEntryCore(
        f.scope,
        () => {
          closeCold(f);
          return { sessionId: "uncommitted" };
        },
        {
          skipMaintenance: true,
          shouldCommit: () => mode !== "cancel" || allowed,
          assertCommitAllowed: () => {
            if (!allowed && mode === "revoke") {
              throw revoked;
            }
          },
          onCommitted: committed,
        },
      ),
    );
    try {
      await expectAdmission(gate, operation);
      allowed = false;
      gate.release.resolve();
      if (mode === "cancel") {
        await expect(operation).resolves.toBeNull();
      } else {
        await expect(operation).rejects.toBe(revoked);
      }
      expect(committed).not.toHaveBeenCalled();
      expect(loadSessionEntry(f.scope)?.sessionId).toBe("original");
      expect(
        getOpenClawAgentDatabaseIfOpen({ agentId: "main", env: f.env })?.db.isTransaction,
      ).toBe(false);
    } finally {
      gate.release.resolve();
    }
  },
);

it.each(["relative queued", "relative updater", "relative native reopen"] as const)(
  "pins the selected root for %s patch work",
  async (mode) => {
    const home = roots.make("session-patch-root-selection-");
    const ownerRoot = path.join(home, "state");
    const successor = path.join(home, "next-cwd");
    fs.mkdirSync(ownerRoot);
    fs.mkdirSync(successor);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_CONFIG_PATH: path.join(ownerRoot, "openclaw.json"),
      OPENCLAW_STATE_DIR: "state",
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", ownerRoot);
    const scope = { agentId: "main", env, sessionKey: "agent:main:root-selection" };
    const original = { ...scope, env: { ...env, OPENCLAW_STATE_DIR: ownerRoot } };
    expect(resolveStateDir(env)).toBe(ownerRoot);
    replaceSessionEntrySync(original, { sessionId: "original", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(original)));
    const selectedPath = database.path;
    const shiftOwner = () => {
      cwd.mockReturnValue(successor);
    };
    const release = createDeferred();
    const updaterEntered = createDeferred();
    releases.push(() => release.resolve());
    const blocker =
      mode === "relative queued"
        ? own(
            runExclusiveSqliteSessionWrite(
              resolveSqliteScope(original),
              async () => {
                await release.promise;
              },
              "session.transcript.batch",
            ),
          )
        : undefined;
    const operation = own(
      patchSessionEntryCore(
        scope,
        () => {
          if (mode !== "relative queued") {
            // The selected store stays A after the updater changes ambient root selection.
            evictHandle(selectedPath);
            shiftOwner();
          }
          updaterEntered.resolve();
          return { label: "retained selected root" };
        },
        {
          skipMaintenance: true,
          assertCommitAllowed: mode === "relative native reopen" ? () => {} : undefined,
        },
      ),
    );
    if (blocker) {
      // Admission was queued with A selected; its first physical open must retain A.
      evictHandle(selectedPath);
      shiftOwner();
      release.resolve();
      await blocker;
    }
    await awaitGateBeforeSettlement(
      updaterEntered.promise,
      operation,
      "Patch settled before its root-selection updater",
    );
    // Control: unchanged caller inputs now resolve elsewhere; the operation must use
    // its private resolved root, not repeat ambient selection after its await.
    expect(resolveStateDir(env)).toBe(path.join(successor, "state"));
    await expect(operation).resolves.toMatchObject({
      sessionId: "original",
      label: "retained selected root",
    });
    expect(loadSessionEntry(original)).toMatchObject({
      sessionId: "original",
      label: "retained selected root",
    });
    expect(env.OPENCLAW_STATE_DIR).toBe("state");
    expect(fs.readdirSync(successor, { recursive: true })).toEqual([]);
  },
);
