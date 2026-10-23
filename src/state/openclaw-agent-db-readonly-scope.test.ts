import fs from "node:fs";
import nodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readExactSessionEntriesWithLifecycle } from "../config/sessions/session-entry-read.worker.js";
import { applyAgentDatabaseReaderRequest } from "../infra/agent-database-readers.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { runSqliteReadOperationSync as runRead } from "../infra/sqlite-schema-facts.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  createOpenClawTestState as createState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { recordOpenClawAgentCanonicalValidation } from "./openclaw-agent-canonical-validation-receipt.js";
import {
  closeOpenClawAgentDatabaseByPath as closeAgentDb,
  closeOpenClawAgentDatabaseByPathAsync as closeAgentDbAsync,
} from "./openclaw-agent-db-lifecycle.js";
import { OpenClawAgentDatabaseReadOnlyScope as ReadScope } from "./openclaw-agent-db-readonly-scope.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly as readAgentDb,
} from "./openclaw-agent-db-readonly.js";
import { releaseOpenClawAgentDatabaseReadValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  openOpenClawAgentDatabase as openAgentDb,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

const thread = vi.hoisted(() => ({ isMainThread: true }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get isMainThread() {
    return thread.isMainThread;
  },
}));

let state: OpenClawTestState;
const scopes: ReadScope[] = [];
beforeEach(async () => {
  state = await createState({ scenario: "minimal" });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  thread.isMainThread = true;
  for (const scope of scopes.splice(0)) {
    scope.close();
  }
  await state.cleanup();
});
function newScope() {
  const scope = new ReadScope();
  scopes.push(scope);
  return scope;
}

async function closedDatabase() {
  const options = { agentId: "main", env: state.env };
  const { path } = openAgentDb(options);
  await closeAgentDbAsync(path);
  return { options, path };
}

function retain(options: Parameters<typeof retainOpenClawAgentDatabaseReadOnly>[0]) {
  const result = retainOpenClawAgentDatabaseReadOnly(options);
  expect(result.found).toBe(true);
  if (!result.found) {
    throw new Error("Missing synthetic agent database");
  }
  return result;
}

it.each([false, true])(
  "reuses admission while reads observe committed writes with snapshot=%s",
  async (snapshot) => {
    const { options, path } = await closedDatabase();
    const scope = newScope();
    using writer = nodeSqlite.openNodeSqliteDatabase(path);

    scope.run({ agentId: "main", path }, () => {
      readAgentDb(({ db: admittedDb }) => {
        const query = getNodeSqliteKysely<{
          schema_meta: { meta_key: string; updated_at: number };
        }>(admittedDb)
          .selectFrom("schema_meta")
          .select("updated_at")
          .where("meta_key", "=", "primary");
        const prepare = vi.spyOn(admittedDb, "prepare");
        const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
        try {
          writer.exec("UPDATE schema_meta SET role = 'state' WHERE meta_key = 'primary'");
          const stampValue = (db: EngineConnection) =>
            executeSqliteQueryTakeFirstSync(db, query)?.updated_at;
          const read = <T>(run: (db: EngineConnection) => T) =>
            readAgentDb(({ db }) => runRead(db, () => run(db)), options, { snapshot });
          const writeStamp = writer.prepare(
            "UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'",
          );
          for (let stamp = 1; stamp <= 20; stamp++) {
            writeStamp.run(stamp);
            expect(
              read((db) => {
                expect(stampValue(db)).toBe(stamp);
                writeStamp.run(stamp + 100);
                return stampValue(db);
              }),
            ).toEqual({ found: true, value: snapshot ? stamp : stamp + 100 });
            expect(read(stampValue)).toEqual({ found: true, value: stamp + 100 });
          }
          const preparations = prepare.mock.calls.filter(([sql]) => sql === query.compile().sql);
          expect(preparations.length).toBeLessThanOrEqual(2);
          expect(
            observation.queries.filter((sql) =>
              /sqlite_schema|sqlite_master|PRAGMA\s+(?:data_version|user_version|schema_version|integrity_check|foreign_key_check)|FROM main\.pragma_data_version\(\)|^SELECT role, schema_version, agent_id/iu.test(
                sql,
              ),
            ),
          ).toEqual([]);
        } finally {
          observation.restore();
          prepare.mockRestore();
        }
      }, options);
    });
  },
);

it("keeps one connection while nested reads retain independent committed snapshots", async () => {
  const { options, path } = await closedDatabase();
  const target = { agentId: "main", path };
  const scope = newScope();
  const writer = new (requireNodeSqlite().DatabaseSync)(path);
  let retained: EngineConnection | undefined;
  const query = "SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'";
  try {
    scope.run(target, () => {
      const first = readAgentDb(({ db }) => {
        retained = db;
        return db.prepare(query).get();
      }, options);
      expect(first.found).toBe(true);
      expect(retained?.isOpen).toBe(true);
      readAgentDb(({ db }) => {
        expect(db).toBe(retained);
        db.exec("BEGIN DEFERRED");
        try {
          const before = db.prepare(query).get();
          writer
            .prepare(
              "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
            )
            .run();
          const committed = writer.prepare(query).get();
          expect(committed).not.toEqual(before);
          const nested = readAgentDb(({ db: inner }) => {
            expect(inner).not.toBe(db);
            return inner.prepare(query).get();
          }, options);
          expect(nested).toEqual({ found: true, value: committed });
          expect(db.prepare(query).get()).toEqual(before);
        } finally {
          db.exec("ROLLBACK");
        }
      }, options);
      expect(readAgentDb(({ db }) => db.prepare(query).get(), options)).toEqual({
        found: true,
        value: writer.prepare(query).get(),
      });
    });
  } finally {
    writer.close();
  }
  scope.close();
  expect(retained?.isOpen).toBe(false);
});

it("reuses ordinary readers until idle expiry and reopens after lifecycle invalidation", async () => {
  const { options, path } = await closedDatabase();
  const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const read = () => readAgentDb(({ db }) => db, options);
  const opens = () => open.mock.calls.filter(([filename]) => filename === path).length;

  const first = read();
  expect(first.found).toBe(true);
  if (!first.found) {
    throw new Error("Missing synthetic agent database");
  }
  for (let index = 0; index < 20; index++) {
    expect(read()).toEqual(first);
  }
  expect(opens()).toBe(1);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(read()).toEqual(first);
  vi.advanceTimersByTime(1);
  expect(first.value.isOpen).toBe(true);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(first.value.isOpen).toBe(false);
  const reopened = read();
  expect(opens()).toBe(2);
  closeAgentDb(path);
  expect(reopened.found && reopened.value.isOpen).toBe(false);
  const replacement = read();
  expect(replacement.found).toBe(true);
  expect(opens()).toBe(3);
  await Promise.resolve();
  expect(replacement.found && replacement.value.isOpen).toBe(true);
  if (replacement.found) {
    replacement.value.close();
  }
  expect(() => vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS)).not.toThrow();
  expect(read().found).toBe(true);
  expect(opens()).toBe(4);
});

it("pins retained readers through idle expiry but revokes them before database removal", async () => {
  const { options, path } = await closedDatabase();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  const retained = retain(options);
  expect(() =>
    readAgentDb(() => "wrong owner", {
      ...options,
      path,
      agentId: "other",
    }),
  ).toThrow("belongs to agent main; requested agent other");
  expect(retained.claim.isCurrent()).toBe(true);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(retained.claim.isCurrent()).toBe(true);
  const other = retain(options);
  expect(other.database.db).toBe(retained.database.db);
  other.claim.release();
  retained.claim.release();
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(retained.database.db.isOpen).toBe(true);
  vi.advanceTimersByTime(1);
  expect(retained.database.db.isOpen).toBe(false);
  const stale = retain(options);
  stale.database.db.close();
  const next = retain(options);
  next.claim.release();
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(next.database.db.isOpen).toBe(false);
  stale.claim.release();
  const reopened = retain(options);
  await closeAgentDbAsync(path);
  expect(reopened.claim.isCurrent()).toBe(false);
  reopened.claim.release();
});

it("promotes a reused reader beyond the maintenance scope that first opened it", async () => {
  const { options } = await closedDatabase();
  const parent = createOpenClawDatabaseMaintenanceScope();
  const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
  const read = () => readAgentDb(({ db }) => db, options);
  try {
    const first = child.run(read);
    expect(parent.run(read)).toEqual(first);
    await child.close();
    expect(first.found && first.value.isOpen).toBe(true);
    await parent.close();
    expect(first.found && first.value.isOpen).toBe(false);
  } finally {
    await child.close();
    await parent.close();
  }
});

it.each(["database-missing", "schema-missing", "callback-error", "idle-expiry"] as const)(
  "keeps retries owned by their explicit scope after %s",
  async (failure) => {
    const options = { agentId: "scope-retry", env: state.env };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const scope = newScope();
    const create = () => {
      openAgentDb(options);
      closeAgentDb(pathname);
    };
    if (failure === "callback-error" || failure === "idle-expiry") {
      create();
    } else if (failure === "schema-missing") {
      fs.mkdirSync(nodePath.dirname(pathname), { recursive: true });
      nodeSqlite.openNodeSqliteDatabase(pathname).close();
    }
    if (failure === "idle-expiry") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }

    await scope.run({ agentId: options.agentId, path: pathname }, async () => {
      if (failure === "idle-expiry") {
        const first = readAgentDb(({ db }) => db, options);
        await Promise.resolve();
        vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
        expect(first.found && first.value.isOpen).toBe(false);
      } else if (failure === "callback-error") {
        const error = new Error("synthetic reader failure");
        expect(() =>
          readAgentDb(() => {
            throw error;
          }, options),
        ).toThrow(error);
      } else {
        expect(readAgentDb(() => "unreachable", options)).toEqual({
          found: false,
          reason: failure,
        });
        create();
      }
      const reopened = readAgentDb(({ db }) => db, options);
      expect(reopened.found && reopened.value.isOpen).toBe(true);
      scope.close();
      expect(reopened.found && reopened.value.isOpen).toBe(false);
    });
  },
);

it("closes generic and explicit candidate-family readers without releasing unrelated paths", async () => {
  const family = state.statePath("selected.sqlite");
  const sibling = state.statePath("selected.extra.sqlite");
  const unrelated = state.statePath("unrelated.sqlite");
  const options = (path: string) => ({ agentId: "main", path, env: state.env });
  for (const path of [family, sibling, unrelated]) {
    openAgentDb(options(path));
    await closeAgentDbAsync(path);
  }
  const scope = newScope();
  const read = (path: string) => {
    const result = readAgentDb(({ db }) => db, options(path));
    if (!result.found) {
      throw new Error("Missing synthetic reader database");
    }
    return result.value;
  };
  const selected = read(family);
  const explicit = scope.run(options(sibling), () => read(sibling));
  const retained = read(unrelated);
  const candidates = [{ path: family, scope: "sibling-family" as const }];
  const closeReaders = () =>
    applyAgentDatabaseReaderRequest({ kind: "close", candidates, deleted: false });

  await applyAgentDatabaseReaderRequest({
    kind: "close",
    candidates,
    deleted: false,
    retainedPaths: [sibling],
  });
  expect(selected.isOpen).toBe(false);
  expect(explicit.isOpen).toBe(true);
  expect(retained.isOpen).toBe(true);
  await closeReaders();
  expect(selected.isOpen).toBe(false);
  expect(explicit.isOpen).toBe(false);
  expect(retained.isOpen).toBe(true);
  expect(read(unrelated)).toBe(retained);

  const reopened = scope.run(options(sibling), () => read(sibling));
  const failure = new Error("native reader close failed");
  const close = vi.spyOn(reopened, "close").mockImplementation(() => {
    throw failure;
  });
  const causes = (error: unknown): unknown[] =>
    error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
  try {
    await expect(closeReaders()).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError && causes(error).includes(failure),
    );
    expect(reopened.isOpen).toBe(true);
    close.mockRestore();
    await closeReaders();
    expect(reopened.isOpen).toBe(false);
    expect(retained.isOpen).toBe(true);
  } finally {
    close.mockRestore();
  }
});

it("loads canonical proof before fresh full selections without trusting a copied file", async () => {
  const { env } = state;

  const options = { agentId: "main", env };
  const database = openAgentDb(options);
  const sessionKey = "agent:main:receipt-read";
  writeSessionEntry(database, sessionKey, { sessionId: "receipt-session", updatedAt: 1 });
  writeSessionEntry(database, "agent:main:unrelated", { sessionId: "unrelated", updatedAt: 1 });
  runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
  await closeAgentDbAsync(database.path, database.agentId);
  releaseOpenClawAgentDatabaseReadValidation([{ path: database.path }]);
  const copiedPath = nodePath.join(nodePath.dirname(database.path), "copied.sqlite");
  fs.copyFileSync(database.path, copiedPath);
  for (const pathname of [database.path, copiedPath]) {
    const target = { ...options, path: pathname };
    const retained = newScope();
    try {
      thread.isMainThread = false;
      retained.run(target, () => {
        const opened = readAgentDb((reader) => reader, target);
        if (!opened.found) {
          throw new Error("Expected the seeded canonical database");
        }
        const queries = trackSqliteStatementExecutions(
          requireNativeSqliteDatabase(opened.value.db),
          ["inventory"],
          (sql) =>
            sql.includes("retained_window") && !/\bwhere\b/iu.test(sql) ? "inventory" : null,
        );
        using _ = { [Symbol.dispose]: () => queries.restore() };

        const result = readExactSessionEntriesWithLifecycle({
          kind: "session-exact-entries",
          database: target,
          env,
          projection: "full",
          selection: { kind: "session-id", sessionId: "receipt-session" },
        });
        expect(result.entries[0]?.entry.sessionId).toBe("receipt-session");
        if (pathname === database.path) {
          expect(queries.rowCounts.inventory).toBe(0);
        } else {
          expect(queries.rowCounts.inventory).toBeGreaterThan(0);
        }
      });
    } finally {
      thread.isMainThread = true;
      retained.close();
    }
  }
});
