import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
  OPENCLAW_AGENT_BOARD_SCHEMA_SQL,
} from "../state/openclaw-agent-schema-history.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import {
  clearSessionProgressCardForReset,
  readSessionProgressCard,
  writeSessionProgressCard,
} from "./progress-card-store.js";

const SESSION_KEY = "agent:main:main";
const STEPS = [
  { step: "Inspect", status: "completed" as const },
  { step: "Patch", status: "in_progress" as const },
];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function measure<T>(db: DatabaseSync, operation: () => T) {
  const counter = trackSqliteStatementExecutions(db, ["all"], () => "all");
  const reads = observeSqliteReadSql(StatementSync.prototype);
  try {
    const result = operation();
    expect.soft(counter.rowCounts.all).toBeGreaterThan(0);
    expect.soft(counter.textBytes.all).toBeLessThan(256);
    expect
      .soft(reads.queries.filter((sql) => /^select .* from "session_progress_cards"/iu.test(sql)))
      .toHaveLength(0);
    return result;
  } finally {
    counter.restore();
    reads.restore();
  }
}

describe("session progress card store", () => {
  let db: DatabaseSync;
  let dbPath: string;
  const write = (input: Parameters<typeof writeSessionProgressCard>[2]) =>
    writeSessionProgressCard(db, SESSION_KEY, input);
  const read = () => readSessionProgressCard(db, SESSION_KEY);
  const reset = () => clearSessionProgressCardForReset(db, SESSION_KEY);
  const stored = () => db.prepare("SELECT * FROM session_progress_cards").get();
  const facts = () => getAdmittedSqliteSchemaFacts(db);
  const setSteps = (json: string) =>
    db.prepare("UPDATE session_progress_cards SET steps_json = ?").run(json);
  const cardAt = (revision: number) => ({ card: expect.objectContaining({ revision }) });
  const expectStored = (
    revision: number,
    updated_at: number,
    markdown: string | null = null,
    steps_json: string | null = null,
  ) => {
    expect(stored()).toEqual({
      session_key: SESSION_KEY,
      markdown,
      steps_json,
      revision,
      created_at: 1000,
      updated_at,
    });
  };

  beforeEach(() => {
    dbPath = path.join(tempDirs.make("progress-card-"), "agent.sqlite");
    db = openNodeSqliteDatabase(dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run(SESSION_KEY, "session-1", JSON.stringify({ sessionId: "session-1" }), 1);
  });

  afterEach(() => {
    try {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([false, true])("replaces, clears, and resets cards (malformed=%s)", (malformed) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const markdown = "é\0" + "x".repeat(4096);
    const nextMarkdown = "Second " + markdown;
    const steps = STEPS.map((entry) => ({ ...entry, step: entry.step + "x".repeat(400) }));
    const setOldSteps = () => setSteps(malformed ? "{" : JSON.stringify(steps));
    write({ markdown, steps });
    expectStored(1, 1000, markdown, JSON.stringify(steps));
    setOldSteps();
    clock.mockReturnValue(2000);
    expect(measure(db, () => write({ markdown: nextMarkdown }))).toEqual({
      card: {
        sessionKey: SESSION_KEY,
        markdown: nextMarkdown,
        revision: 2,
        updatedAt: 2000,
      },
    });
    expect(read()).toEqual(expect.objectContaining({ markdown: nextMarkdown, revision: 2 }));
    expect(read()?.steps).toBeUndefined();
    expectStored(2, 2000, nextMarkdown);
    setOldSteps();
    clock.mockReturnValue(3000);
    expect(measure(db, () => write({ markdown: "  \n ", steps: [] }))).toEqual({ cleared: true });
    expect(read()).toBeNull();
    expectStored(3, 3000);
    write({ markdown, steps });
    setOldSteps();
    const foreign = new DatabaseSync(dbPath);
    try {
      foreign
        .prepare("UPDATE session_progress_cards SET revision = ? WHERE session_key = ?")
        .run(7, SESSION_KEY);
    } finally {
      foreign.close();
    }
    clock.mockReturnValue(4000);
    expect(runSqliteImmediateTransactionSync(db, () => measure(db, reset))).toBe(true);
    expectStored(8, 4000);
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    db = openNodeSqliteDatabase(dbPath);
    expectStored(8, 4000);
    expect(read()).toBeNull();
  });

  it("treats a missing lazy table as no card without creating it", () => {
    db.close();
    db = new DatabaseSync(":memory:");
    db.exec(
      OPENCLAW_AGENT_SCHEMA_SQL.replace(OPENCLAW_AGENT_BOARD_SCHEMA_SQL, "").replace(
        AGENT_PROGRESS_CARD_SCHEMA_SQL,
        "",
      ),
    );

    expect(reset()).toBe(false);
    expect(read()).toBeNull();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("session_progress_cards"),
    ).toBeUndefined();
  });

  it("creates lazy storage once and retains admitted facts across warm writes and reads", () => {
    db.exec("DROP TABLE session_progress_cards");
    admitSqliteSchema(db);
    expect(facts()?.tables.has("session_progress_cards")).toBe(false);
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    write({ markdown: "First" });
    expect(exec.mock.calls.filter(([sql]) => /CREATE TABLE/iu.test(sql))).toHaveLength(1);
    const admittedFacts = facts();
    expect(admittedFacts?.tables.has("session_progress_cards")).toBe(true);
    const sibling = openNodeSqliteDatabase(dbPath, { readOnly: true });
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      admitSqliteSchema(sibling);
      const siblingFacts = getAdmittedSqliteSchemaFacts(sibling);
      exec.mockClear();
      reads.queries.length = 0;

      write({ markdown: "Second" });
      expect(read()).toMatchObject({ markdown: "Second", revision: 2 });
      expect(facts()).toBe(admittedFacts);
      expect(getAdmittedSqliteSchemaFacts(sibling)).toBe(siblingFacts);
      write({});
      write({ markdown: "Next task" });
      expect(reset()).toBe(true);
      expect(read()).toBeNull();
      expect(facts()).toBe(admittedFacts);
      expect(getAdmittedSqliteSchemaFacts(sibling)).toBe(siblingFacts);
      expect(exec.mock.calls.filter(([sql]) => /CREATE/iu.test(sql))).toEqual([]);
      expect(reads.queries.filter((sql) => /sqlite_schema|sqlite_master/iu.test(sql))).toEqual([]);
    } finally {
      sibling.close();
    }
  });

  it("recreates lazy storage after rolling back its first write", () => {
    db.exec("DROP TABLE session_progress_cards");
    admitSqliteSchema(db);
    let transactionalFacts: ReturnType<typeof getAdmittedSqliteSchemaFacts>;
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        write({ markdown: "Rolled back" });
        transactionalFacts = facts();
        expect(transactionalFacts?.tables.has("session_progress_cards")).toBe(true);
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    const rolledBackFacts = facts();
    expect(rolledBackFacts).not.toBe(transactionalFacts);
    expect(rolledBackFacts?.tables.has("session_progress_cards")).toBe(false);
    expect(read()).toBeNull();
    write({ markdown: "Retried" });
    expect(read()).toMatchObject({ markdown: "Retried", revision: 1 });
  });

  it("observes managed schema publication before recreating lazy storage", () => {
    admitSqliteSchema(db);
    write({ markdown: "Before foreign DDL" });
    const admittedFacts = facts();
    const foreign = openNodeSqliteDatabase(dbPath);
    try {
      foreign.exec("DROP TABLE session_progress_cards");
    } finally {
      foreign.close();
    }
    const reads = observeSqliteReadSql(StatementSync.prototype);
    write({ markdown: "After foreign DDL" });
    expect(read()).toMatchObject({ markdown: "After foreign DDL", revision: 1 });
    expect(facts()).not.toBe(admittedFacts);
    expect(reads.queries.some((sql) => /sqlite_schema/iu.test(sql))).toBe(true);
  });

  it("deletes the card when its owning session node is deleted", () => {
    write({ markdown: "Owned by the session" });

    db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(SESSION_KEY);

    expect(read()).toBeNull();
  });

  it("dismisses the card only at its expected revision", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const steps = [{ step: "Done", status: "completed" as const }];
    write({ steps });

    setSteps("{");
    const malformed = stored();
    expect(() => write({ expectedRevision: 2 })).toThrow(SyntaxError);
    expect(stored()).toEqual(malformed);
    setSteps(JSON.stringify(steps));

    expect(write({ expectedRevision: 2 })).toEqual(cardAt(1));
    expect(read()).not.toBeNull();
    expect(write({ expectedRevision: 1 })).toEqual({ cleared: true });
    expect(read()).toBeNull();

    expect(write({ steps: [{ step: "New work", status: "in_progress" }] })).toEqual(cardAt(3));
    expect(write({ expectedRevision: 1 })).toEqual(cardAt(3));
  });

  it("dismisses active and note-only cards at the expected revision", () => {
    write({ steps: STEPS });
    expect(write({ expectedRevision: 1 })).toEqual({ cleared: true });
    expect(read()).toBeNull();
    expect(write({ expectedRevision: 2 })).toEqual({ card: null });
    expect(db.prepare("SELECT revision FROM session_progress_cards").get()?.revision).toBe(2);

    write({ markdown: "Still relevant" });
    const current = read();
    expect(write({ expectedRevision: 1 })).toEqual({ card: current });
    expect(read()).toEqual(current);
    expect(write({ expectedRevision: 3 })).toEqual({ cleared: true });
    expect(read()).toBeNull();
  });

  it.each(["revision", "created_at"] as const)("rejects unsafe %s before decoding", (column) => {
    write({ markdown: "Existing", steps: STEPS });
    db.prepare(`UPDATE session_progress_cards SET ${column} = ?, steps_json = ?`).run(
      9007199254740993n,
      "{",
    );
    const inspect = db.prepare("SELECT * FROM session_progress_cards");
    inspect.setReadBigInts(true);
    const before = inspect.get();
    const operations = {
      replace: () => write({ markdown: "Replacement" }),
      clear: () => write({}),
      reset: () => runSqliteImmediateTransactionSync(db, reset),
      dismiss: () => write({ expectedRevision: 2 }),
    };
    for (const [name, operation] of Object.entries(operations)) {
      expect(operation, name).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
      expect(inspect.get(), name).toEqual(before);
    }
  });
});
