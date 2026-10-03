import fs from "node:fs";
import { afterEach, assert, expect, it, vi } from "vitest";
import * as diskSpace from "../infra/disk-space.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import { configureSqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { classifyDoctorMaintenanceRefusal } from "./doctor-maintenance-inspection.js";
import { enableDoctorSqliteReclamation } from "./doctor-sqlite-reclamation.js";

afterEach(() => vi.restoreAllMocks());

async function seed(state: OpenClawTestState, withAgent = false) {
  const shared = openOpenClawStateDatabase({ env: state.env }).path;
  const agents: AgentDatabaseMigrationTarget[] = [];
  if (withAgent) {
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    agents.push({ agentId: "main", path: agent.path, realPath: agent.path, source: "configured" });
    agent.db.exec(`
      INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at)
        VALUES ('agent:main:history','hot','{"sessionId":"hot","updatedAt":2}',2);
      INSERT INTO session_windows(session_id,session_key,created_at,updated_at)
        VALUES ('hot','agent:main:history',1,2);
      INSERT INTO transcript_events(rowid,session_id,seq,event_json,created_at)
        VALUES (41,'hot',7,'{"type":"message","id":"kept"}',11);
      INSERT INTO session_transcript_fts(rowid,text,session_id,message_id,role,timestamp)
        VALUES (-17,'saffronquasar 雪','hot','kept','assistant','2026-10-01');
      INSERT INTO session_transcript_fts_rows(id,session_id,message_id) VALUES (-17,'hot','kept');
    `);
  }
  await closeOpenClawAgentDatabasesAsync(state.stateDir);
  await closeOpenClawStateDatabaseAsync();
  const paths = [shared, ...agents.map((agent) => agent.path)];
  for (const pathname of paths) {
    const db = openNodeSqliteDatabase(pathname);
    try {
      db.exec(`PRAGMA auto_vacuum=NONE; VACUUM;
        CREATE TABLE retained(id INTEGER PRIMARY KEY, text TEXT);
        CREATE TABLE discarded(data BLOB);
        INSERT INTO discarded VALUES(zeroblob(1048576)); DELETE FROM discarded;`);
      db.prepare("INSERT INTO retained VALUES (41, ?)").run("kept π \0 雪");
    } finally {
      db.close();
    }
  }
  return { shared, agents, paths };
}

function inspect(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return {
      mode: db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum,
      free: Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count),
      retained: db.prepare("SELECT id,hex(CAST(text AS BLOB)) AS bytes FROM retained").all(),
      integrity: db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    };
  } finally {
    db.close();
  }
}

function convert(
  state: OpenClawTestState,
  options: {
    agents?: AgentDatabaseMigrationTarget[];
    signal?: AbortSignal;
    assertCurrent?: () => void;
    log?: (message: string) => void;
  } = {},
) {
  return enableDoctorSqliteReclamation({
    env: state.env,
    agents: options.agents ?? [],
    signal: options.signal ?? new AbortController().signal,
    assertCurrent: options.assertCurrent ?? (() => {}),
    log: options.log ?? (() => {}),
  });
}

it("converts legacy stores once, preserves canonical rowids/search, and enables later reclamation", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const { shared, agents, paths } = await seed(state, true);
    const before = paths.map(inspect);
    expect(before.every((item) => item.mode === 0 && item.free > 0)).toBe(true);
    await expect(convert(state, { agents })).resolves.toEqual({ warnings: [] });
    expect(paths.map(inspect)).toEqual(
      before.map((item) => Object.assign({}, item, { mode: 2, free: 0 })),
    );
    const [agentTarget] = agents;
    assert.isDefined(agentTarget);
    const agent = openNodeSqliteDatabase(agentTarget.path, { readOnly: true });
    try {
      expect(agent.prepare("SELECT rowid,seq FROM transcript_events").all()).toEqual([
        { rowid: 41, seq: 7 },
      ]);
      expect(
        agent
          .prepare(
            "SELECT rowid FROM session_transcript_fts WHERE session_transcript_fts MATCH 'saffronquasar'",
          )
          .all(),
      ).toEqual([{ rowid: -17 }]);
      expect(agent.prepare("SELECT * FROM session_transcript_fts_rows").all()).toEqual([
        { id: -17, session_id: "hot", message_id: "kept" },
      ]);
    } finally {
      agent.close();
    }
    const compactedBytes = paths.map((pathname) => fs.readFileSync(pathname));
    const log = vi.fn();
    await expect(convert(state, { agents, log })).resolves.toEqual({ warnings: [] });
    expect(log).not.toHaveBeenCalled();
    expect(paths.map((pathname) => fs.readFileSync(pathname))).toEqual(compactedBytes);

    const db = openNodeSqliteDatabase(shared);
    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: shared,
    });
    try {
      db.exec("INSERT INTO discarded VALUES(zeroblob(1048576)); DELETE FROM discarded;");
      const result = maintenance.reclaimFreePages({ maxPages: 5 });
      expect(result.freePagesBefore).toBeGreaterThan(5);
      expect(result.freePagesBefore! - result.remainingFreePages!).toBeGreaterThan(0);
      expect(result.freePagesBefore! - result.remainingFreePages!).toBeLessThanOrEqual(5);
      expect(result.checkpointCompleted).toBe(true);
      expect(db.prepare("SELECT text FROM retained").get()?.text).toBe("kept π \0 雪");
    } finally {
      maintenance.close();
      db.close();
    }
  });
});

it.each([1, 2])("does not rewrite an existing auto-vacuum=%s store", async (mode) => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const { shared } = await seed(state);
    const db = openNodeSqliteDatabase(shared);
    db.exec(`PRAGMA auto_vacuum=${mode}; VACUUM;`);
    db.close();
    const before = fs.readFileSync(shared);
    await expect(convert(state)).resolves.toEqual({ warnings: [] });
    expect(fs.readFileSync(shared)).toEqual(before);
    expect(inspect(shared).mode).toBe(mode);
  });
});

it.each([1, 2])("defers a replaced auto-vacuum=%s path after the read-only close", async (mode) => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const { shared } = await seed(state);
    const replacement = state.path("legacy-replacement.sqlite");
    const original = state.path("enabled-original.sqlite");
    fs.copyFileSync(shared, replacement);
    const replacementBytes = fs.readFileSync(replacement);
    const enabled = openNodeSqliteDatabase(shared);
    enabled.exec(`PRAGMA auto_vacuum=${mode}; VACUUM;`);
    enabled.close();
    const open = nodeSqlite.openNodeSqliteDatabase;
    let replaced = false;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
      const database = open(pathname, options);
      if (options?.readOnly && pathname === shared && !replaced) {
        const close = database.close.bind(database);
        vi.spyOn(database, "close").mockImplementation(() => {
          close();
          fs.renameSync(shared, original);
          fs.renameSync(replacement, shared);
          replaced = true;
        });
      }
      return database;
    });
    const result = await convert(state);
    expect(replaced).toBe(true);
    expect(inspect(original).mode).toBe(mode);
    expect(fs.readFileSync(shared)).toEqual(replacementBytes);
    expect(inspect(shared).mode).toBe(0);
    expect(result.warnings).toEqual([expect.stringContaining("database file identity changed")]);
  });
});

it.each(["low", "unknown"])(
  "defers optional conversion with %s capacity without rewriting data",
  async (capacity) => {
    await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
      const { shared } = await seed(state);
      const before = fs.readFileSync(shared);
      vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue(
        capacity === "unknown"
          ? null
          : {
              targetPath: state.stateDir,
              checkedPath: state.stateDir,
              availableBytes: 0,
              totalBytes: 1024,
            },
      );
      const result = await convert(state);
      expect(result.warnings).toEqual([
        expect.stringContaining("openclaw doctor --state-sqlite compact"),
      ]);
      expect(fs.readFileSync(shared)).toEqual(before);
      expect(inspect(shared).mode).toBe(0);
    });
  },
);

it("defers a real reader-held initial WAL checkpoint after closing the compactor", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const { shared } = await seed(state);
    const reader = openNodeSqliteDatabase(shared);
    const writer = openNodeSqliteDatabase(shared);
    try {
      reader.exec("BEGIN; SELECT * FROM retained;");
      writer.exec("INSERT INTO retained VALUES(42,'pending checkpoint');");
      const before = inspect(shared);
      const result = await convert(state);
      expect(result.warnings).toEqual([expect.stringContaining("checkpoint remained busy")]);
      expect(inspect(shared)).toEqual(before);
      reader.exec("ROLLBACK;");
      expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
      writer.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    } finally {
      if (reader.isTransaction) {
        reader.exec("ROLLBACK;");
      }
      reader.close();
      writer.close();
    }
  });
});

it("preserves real integrity failure as unsafe when cancellation arrives with it", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const { shared } = await seed(state);
    const db = openNodeSqliteDatabase(shared);
    db.exec(
      "PRAGMA foreign_keys=OFF; CREATE TABLE child(parent_id REFERENCES retained(id)); INSERT INTO child VALUES(999);",
    );
    db.close();
    const controller = new AbortController();
    const interruption = new Error("cancelled after native integrity failure");
    const assertIntegrity = sqliteIntegrity.assertSqliteIntegrity;
    let nativeFailure: unknown;
    vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity").mockImplementation((...args) => {
      try {
        return assertIntegrity(...args);
      } catch (error) {
        nativeFailure = error;
        controller.abort(interruption);
        throw error;
      }
    });
    const error = await convert(state, { signal: controller.signal }).catch(
      (cause: unknown) => cause,
    );
    expect(nativeFailure).toBeInstanceOf(Error);
    expect(String(nativeFailure)).toContain("foreign_key_check failed");
    expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
    expect(classifyDoctorMaintenanceRefusal(error)).toEqual({
      kind: "data-at-risk",
      reason: "incomplete-migration",
    });
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toEqual([
      nativeFailure,
      interruption,
    ]);
    expect(inspect(shared).mode).toBe(0);
  });
});

it("rejects a pathname replacement after the native compactor closes", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const { shared } = await seed(state);
    const replacement = state.path("replacement.sqlite");
    const converted = state.path("converted.sqlite");
    fs.copyFileSync(shared, replacement);
    const replacementBytes = fs.readFileSync(replacement);
    const open = nodeSqlite.openNodeSqliteDatabase;
    let replaced = false;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
      const database = open(pathname, options);
      if (!options?.readOnly && pathname.startsWith("file:")) {
        const close = database.close.bind(database);
        vi.spyOn(database, "close").mockImplementation(() => {
          close();
          fs.renameSync(shared, converted);
          fs.renameSync(replacement, shared);
          replaced = true;
        });
      }
      return database;
    });
    const result = await convert(state).catch((error: unknown) => error);
    expect(replaced).toBe(true);
    expect(inspect(converted)).toMatchObject({ mode: 2, integrity: "ok" });
    expect(fs.readFileSync(shared)).toEqual(replacementBytes);
    expect(inspect(shared).mode).toBe(0);
    expect(result).toBeInstanceOf(DoctorMaintenanceRefusalError);
    expect(classifyDoctorMaintenanceRefusal(result)).toEqual({
      kind: "data-at-risk",
      reason: "incomplete-migration",
    });
  });
});

it("delivers queued cancellation after verified closure and before the next database", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const { shared, agents } = await seed(state, true);
    const [agentTarget] = agents;
    assert.isDefined(agentTarget);
    const agentBefore = fs.readFileSync(agentTarget.path);
    const controller = new AbortController();
    const interruption = new Error("stop before another database");
    await expect(
      convert(state, {
        agents,
        signal: controller.signal,
        log: (message) => {
          if (message.startsWith("Enabled")) {
            setImmediate(() => controller.abort(interruption));
          }
        },
      }),
    ).rejects.toBe(interruption);
    expect(inspect(shared)).toMatchObject({ mode: 2, free: 0, integrity: "ok" });
    expect(fs.readFileSync(agentTarget.path)).toEqual(agentBefore);
  });
});
