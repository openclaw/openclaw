import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConnection } from "../infra/sql-connection.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  createOpenClawTestState as createState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly as readAgentDb } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath as closeAgentDb,
  openOpenClawAgentDatabase as openAgentDb,
  type OpenClawAgentDatabaseOptions as AgentDbOptions,
} from "./openclaw-agent-db.js";

const stampQuery = "SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'";

function readStamp(options: AgentDbOptions, behavior?: { allowExtension?: boolean }) {
  const result = readAgentDb(
    ({ db }) => ({ db, stamp: db.prepare(stampQuery).get()?.updated_at }),
    options,
    behavior,
  );
  if (!result.found) {
    throw new Error(`Expected existing fixture database: ${result.reason}`);
  }
  return result.value;
}

function inWriterTransaction<T>(connection: EngineConnection, operation: () => T): T {
  const db = requireNativeSqliteDatabase(connection);
  db.exec("BEGIN IMMEDIATE");
  try {
    return operation();
  } finally {
    if (db.isOpen && db.isTransaction) {
      db.exec("ROLLBACK");
    }
  }
}

let state: OpenClawTestState;
let options: AgentDbOptions;
let owner: ReturnType<typeof openAgentDb>;
beforeEach(async () => {
  state = await createState({ scenario: "minimal" });
  options = { agentId: "main", env: state.env };
  owner = openAgentDb(options);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await state.cleanup();
});
const read = (behavior?: { allowExtension?: boolean }) => readStamp(options, behavior);
const transaction = <T>(run: () => T) => inWriterTransaction(owner.db, run);
const stamp = (value: number) =>
  owner.db.prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'").run(value);

describe("committed agent database reads", () => {
  it("reuses a separate reader across nested reads and committed writer transactions", async () => {
    stamp(101);
    const reader = transaction(() => {
      stamp(202);
      const first = read();
      expect(first).toMatchObject({ stamp: 101, db: { isOpen: true } });
      expect(first.db).not.toBe(owner.db);
      const second = readAgentDb(({ db }) => {
        expect(db).toBe(first.db);
        const nested = read();
        expect(nested.db).not.toBe(owner.db);
        expect(nested.stamp).toBe(101);
        expect(db.isOpen).toBe(true);
        return db.prepare(stampQuery).get()?.updated_at;
      }, options);
      expect(second).toEqual({ found: true, value: 101 });
      expect(read().db).toBe(first.db);
      expect(owner.db.isTransaction).toBe(true);
      return first.db;
    });

    stamp(303);
    transaction(() => {
      stamp(404);
      const current = read();
      expect(current.db).toBe(reader);
      expect(current.stamp).toBe(303);
    });
    expect(read().db).toBe(owner.db);
    expect(read().stamp).toBe(303);
  });

  it.each([
    [
      AGENT_MEDIA_SCHEMA_VERSION - 1,
      "OpenClawAgentDatabaseMediaMigrationRequiredError",
      "run openclaw doctor --fix to migrate persisted media",
    ],
    [
      OPENCLAW_AGENT_SCHEMA_VERSION - 1,
      "SqliteSchemaMismatchError",
      "stop active agents and run openclaw doctor --fix to migrate session identities",
    ],
  ] as const)(
    "rejects a replacement at version %s before invoking a committed reader",
    async (version, name, message) => {
      const expectedError = { name, message: expect.stringContaining(message) };
      const { path: databasePath } = owner;

      let admitted: boolean;
      const readReplacement = () =>
        readAgentDb(({ db }) => {
          admitted = true;
          return db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'").get();
        }, options);
      expect(readReplacement()).toEqual({ found: true, value: { agent_id: "main" } });
      admitted = false;
      expect(closeAgentDb(databasePath)).toBe(true);
      fs.copyFileSync(databasePath, `${databasePath}.replacement`);
      fs.renameSync(`${databasePath}.replacement`, databasePath);
      {
        using writer = new DatabaseSync(databasePath);

        writer.exec(`BEGIN IMMEDIATE; PRAGMA user_version = ${version}; COMMIT;`);
      }
      expect(readReplacement).toThrow(expect.objectContaining(expectedError));
      expect(admitted).toBe(false);
      expect(readReplacement).toThrow(expect.objectContaining(expectedError));
      expect(admitted).toBe(false);
    },
  );

  it("retires the committed reader before closing its owner's WAL", async () => {
    const reader = transaction(() => read().db);
    expect(reader.isOpen).toBe(true);
    const originalWalClose = owner.walMaintenance.close.bind(owner.walMaintenance);
    const walClose = vi.spyOn(owner.walMaintenance, "close").mockImplementation((closeOptions) => {
      expect(reader.isOpen).toBe(false);
      return originalWalClose(closeOptions);
    });
    closeAgentDb(owner.path);
    expect(reader.isOpen).toBe(false);
    expect(walClose).toHaveBeenCalled();
  });

  it.runIf(typeof DatabaseSync.prototype.deserialize === "function")(
    "retires the reader before a failed native deserialize attempt without closing its writer",
    async () => {
      stamp(101);
      const db = requireNativeSqliteDatabase(owner.db);
      const bytes = db.serialize();
      transaction(() => {
        owner.db.prepare(stampQuery).get();
        const reader = read().db;
        // SQLite rejects replacement while the connection holds a transaction.
        expect(() => db.deserialize(bytes)).toThrow();
        expect(reader.isOpen).toBe(false);
        expect(owner.db).toMatchObject({ isOpen: true, isTransaction: true });
        const next = read();
        expect(next.db).not.toBe(reader);
        expect(next.stamp).toBe(101);
      });
      expect(read().stamp).toBe(101);
    },
  );

  it.each([false, true])(
    "closes a leaked reader transaction when the callback throws=%s",
    async (throws) => {
      transaction(() => {
        const reader = read().db;
        expect(reader.isOpen).toBe(true);
        const leak = () =>
          readAgentDb(({ db }) => {
            expect(db).toBe(reader);
            db.exec("BEGIN");
            db.prepare(stampQuery).get();
            if (throws) {
              throw new Error("synthetic reader failure");
            }
          }, options);
        if (throws) {
          expect(leak).toThrow("synthetic reader failure");
        } else {
          leak();
        }
        expect(reader.isOpen).toBe(false);
        expect(owner.db.isTransaction).toBe(true);
        const next = read();
        expect(next.db).not.toBe(reader);
        expect(next.db.isTransaction).toBe(false);
      });
    },
  );

  it("keeps extension-capable reads isolated and one-shot", async () => {
    transaction(() => {
      const first = read({ allowExtension: true });
      const second = read({ allowExtension: true });
      expect(first.db).not.toBe(owner.db);
      expect(second.db).not.toBe(first.db);
      expect(first.db.isOpen).toBe(false);
      expect(second.db.isOpen).toBe(false);
    });
  });

  it.runIf(process.platform !== "win32")(
    "retires an old companion after its pathname is retargeted to another same-agent database",
    async () => {
      const original = openAgentDb({ agentId: "main", env: state.env });
      original.db.exec("UPDATE schema_meta SET updated_at = 101 WHERE meta_key = 'primary'");
      const replacement = openAgentDb({
        agentId: "main",
        env: state.env,
        path: state.path("replacement.sqlite"),
      });
      replacement.db.exec("UPDATE schema_meta SET updated_at = 202 WHERE meta_key = 'primary'");
      const alias = state.path("alias.sqlite");
      fs.symlinkSync(original.path, alias);
      const aliasOptions = { agentId: "main", env: state.env, path: alias };
      const aliasOwner = openAgentDb(aliasOptions);
      const previousReader = inWriterTransaction(aliasOwner.db, () => readStamp(aliasOptions).db);
      expect(previousReader.isOpen).toBe(true);
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement.path, alias);
      inWriterTransaction(aliasOwner.db, () => {
        const current = readStamp(aliasOptions);
        expect(current.stamp).toBe(202);
        expect(current.db).not.toBe(previousReader);
        expect(current.db).not.toBe(aliasOwner.db);
        expect(previousReader.isOpen).toBe(false);
      });
    },
  );
});

it("retries idle committed-reader close without losing its retained native handle", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reader = transaction(() => read().db);
  vi.spyOn(reader, "close").mockImplementationOnce(() => {
    throw new Error("synthetic native close failure");
  });
  expect(() => vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS)).not.toThrow();
  expect(reader.isOpen).toBe(true);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(reader.isOpen).toBe(false);
  const reopened = transaction(() => read().db);
  expect(reopened).not.toBe(reader);
  expect(reopened.isOpen).toBe(true);
});
