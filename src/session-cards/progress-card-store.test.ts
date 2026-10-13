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
import { AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL } from "../state/openclaw-agent-progress-card-schema.js";
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
  try {
    const result = operation();
    return {
      result,
      metrics: {
        rows: counter.rowCounts.all,
        returnedTextBytes: counter.textBytes.all,
      },
    };
  } finally {
    counter.restore();
  }
}

describe("session progress card store", () => {
  let db: DatabaseSync;
  let dbPath: string;

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

  it.each([
    { name: "markdown only", input: { markdown: "Working" }, expected: { markdown: "Working" } },
    { name: "plan only", input: { steps: STEPS }, expected: { steps: STEPS } },
    {
      name: "markdown and plan",
      input: { markdown: "Working", steps: STEPS },
      expected: { markdown: "Working", steps: STEPS },
    },
  ])("roundtrips $name", ({ input, expected }) => {
    const written = writeSessionProgressCard(db, SESSION_KEY, input);

    expect(written).toEqual({
      card: expect.objectContaining({
        sessionKey: SESSION_KEY,
        revision: 1,
        ...expected,
      }),
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toEqual(
      expect.objectContaining({ sessionKey: SESSION_KEY, revision: 1, ...expected }),
    );
  });

  it.each([false, true])(
    "replaces the whole card, advances its revision, and clears on empty input (malformed=%s)",
    (malformed) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const markdown = "é\0" + "x".repeat(4096);
      const nextMarkdown = "Second " + markdown;
      const steps = STEPS.map((entry) => ({ ...entry, step: entry.step + "x".repeat(400) }));
      const stored = () => db.prepare("SELECT * FROM session_progress_cards").get();
      const setOldSteps = () =>
        db
          .prepare("UPDATE session_progress_cards SET steps_json = ?")
          .run(malformed ? "{" : JSON.stringify(steps));
      writeSessionProgressCard(db, SESSION_KEY, { markdown, steps });
      const insertedRow = stored();
      expect(insertedRow).toEqual({
        session_key: SESSION_KEY,
        markdown,
        steps_json: JSON.stringify(steps),
        revision: 1,
        created_at: 1000,
        updated_at: 1000,
      });
      setOldSteps();
      clock.mockReturnValue(2000);
      const replaced = measure(db, () =>
        writeSessionProgressCard(db, SESSION_KEY, { markdown: nextMarkdown }),
      );
      expect(replaced.result).toEqual({
        card: {
          sessionKey: SESSION_KEY,
          markdown: nextMarkdown,
          revision: 2,
          updatedAt: 2000,
        },
      });
      expect(readSessionProgressCard(db, SESSION_KEY)).toEqual(
        expect.objectContaining({ markdown: nextMarkdown, revision: 2 }),
      );
      expect(readSessionProgressCard(db, SESSION_KEY)?.steps).toBeUndefined();
      const replacedRow = stored();
      expect(replacedRow).toEqual({
        session_key: SESSION_KEY,
        markdown: nextMarkdown,
        steps_json: null,
        revision: 2,
        created_at: 1000,
        updated_at: 2000,
      });
      setOldSteps();
      clock.mockReturnValue(3000);
      const cleared = measure(db, () =>
        writeSessionProgressCard(db, SESSION_KEY, { markdown: "  \n ", steps: [] }),
      );
      expect(cleared.result).toEqual({ cleared: true });
      expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
      const clearedRow = stored();
      expect(clearedRow).toEqual({
        session_key: SESSION_KEY,
        markdown: null,
        steps_json: null,
        revision: 3,
        created_at: 1000,
        updated_at: 3000,
      });
      writeSessionProgressCard(db, SESSION_KEY, { markdown, steps });
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
      const reset = runSqliteImmediateTransactionSync(db, () => {
        const reads = observeSqliteReadSql(StatementSync.prototype);
        try {
          const measured = measure(db, () => clearSessionProgressCardForReset(db, SESSION_KEY));
          expect(
            reads.queries.filter((sql) => /^select .* from "session_progress_cards"/iu.test(sql)),
          ).toHaveLength(1);
          return measured;
        } finally {
          reads.restore();
        }
      });
      expect(reset.result).toBe(true);
      const expectedTombstone = {
        session_key: SESSION_KEY,
        markdown: null,
        steps_json: null,
        revision: 8,
        created_at: 1000,
        updated_at: 4000,
      };
      const resetRow = stored();
      expect(resetRow).toEqual(expectedTombstone);
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
      db = openNodeSqliteDatabase(dbPath);
      const reopenedRow = stored();
      expect(reopenedRow).toEqual(expectedTombstone);
      expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
      for (const measured of [replaced, cleared, reset]) {
        expect.soft(measured.metrics.rows).toBeGreaterThan(0);
        expect.soft(measured.metrics.returnedTextBytes).toBeLessThan(256);
      }
    },
  );

  it("treats a missing lazy table as no card without creating it", () => {
    db.close();
    db = new DatabaseSync(":memory:");
    db.exec(AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL);

    expect(clearSessionProgressCardForReset(db, SESSION_KEY)).toBe(false);
    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("session_progress_cards"),
    ).toBeUndefined();
  });

  it("creates lazy storage once and retains admitted facts across warm writes and reads", () => {
    db.exec("DROP TABLE session_progress_cards");
    admitSqliteSchema(db);
    expect(getAdmittedSqliteSchemaFacts(db)?.tables.has("session_progress_cards")).toBe(false);
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    writeSessionProgressCard(db, SESSION_KEY, { markdown: "First" });
    expect(exec.mock.calls.filter(([sql]) => /CREATE TABLE/iu.test(sql))).toHaveLength(1);
    const facts = getAdmittedSqliteSchemaFacts(db);
    expect(facts?.tables.has("session_progress_cards")).toBe(true);
    const sibling = openNodeSqliteDatabase(dbPath, { readOnly: true });
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      admitSqliteSchema(sibling);
      const siblingFacts = getAdmittedSqliteSchemaFacts(sibling);
      exec.mockClear();
      reads.queries.length = 0;

      writeSessionProgressCard(db, SESSION_KEY, { markdown: "Second" });
      expect(readSessionProgressCard(db, SESSION_KEY)).toMatchObject({
        markdown: "Second",
        revision: 2,
      });
      expect(getAdmittedSqliteSchemaFacts(db)).toBe(facts);
      expect(getAdmittedSqliteSchemaFacts(sibling)).toBe(siblingFacts);
      writeSessionProgressCard(db, SESSION_KEY, {});
      writeSessionProgressCard(db, SESSION_KEY, { markdown: "Next task" });
      expect(clearSessionProgressCardForReset(db, SESSION_KEY)).toBe(true);
      expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
      expect(getAdmittedSqliteSchemaFacts(db)).toBe(facts);
      expect(getAdmittedSqliteSchemaFacts(sibling)).toBe(siblingFacts);
      expect(exec.mock.calls.filter(([sql]) => /CREATE/iu.test(sql))).toEqual([]);
      expect(reads.queries.filter((sql) => /sqlite_schema|sqlite_master/iu.test(sql))).toEqual([]);
    } finally {
      reads.restore();
      sibling.close();
    }
  });

  it("recreates lazy storage after rolling back its first write", () => {
    db.exec("DROP TABLE session_progress_cards");
    admitSqliteSchema(db);
    let transactionalFacts: ReturnType<typeof getAdmittedSqliteSchemaFacts>;
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        writeSessionProgressCard(db, SESSION_KEY, { markdown: "Rolled back" });
        transactionalFacts = getAdmittedSqliteSchemaFacts(db);
        expect(transactionalFacts?.tables.has("session_progress_cards")).toBe(true);
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    const rolledBackFacts = getAdmittedSqliteSchemaFacts(db);
    expect(rolledBackFacts).not.toBe(transactionalFacts);
    expect(rolledBackFacts?.tables.has("session_progress_cards")).toBe(false);
    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
    writeSessionProgressCard(db, SESSION_KEY, { markdown: "Retried" });
    expect(readSessionProgressCard(db, SESSION_KEY)).toMatchObject({
      markdown: "Retried",
      revision: 1,
    });
  });

  it("observes managed schema publication before recreating lazy storage", () => {
    admitSqliteSchema(db);
    writeSessionProgressCard(db, SESSION_KEY, { markdown: "Before foreign DDL" });
    const facts = getAdmittedSqliteSchemaFacts(db);
    const foreign = openNodeSqliteDatabase(dbPath);
    try {
      foreign.exec("DROP TABLE session_progress_cards");
    } finally {
      foreign.close();
    }
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      writeSessionProgressCard(db, SESSION_KEY, { markdown: "After foreign DDL" });
      expect(readSessionProgressCard(db, SESSION_KEY)).toMatchObject({
        markdown: "After foreign DDL",
        revision: 1,
      });
      expect(getAdmittedSqliteSchemaFacts(db)).not.toBe(facts);
      expect(reads.queries.some((sql) => /sqlite_schema/iu.test(sql))).toBe(true);
    } finally {
      reads.restore();
    }
  });

  it("deletes the card when its owning session node is deleted", () => {
    writeSessionProgressCard(db, SESSION_KEY, { markdown: "Owned by the session" });

    db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(SESSION_KEY);

    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
  });

  it("dismisses the card only at its expected revision", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    writeSessionProgressCard(db, SESSION_KEY, {
      steps: [{ step: "Done", status: "completed" }],
    });

    db.prepare("UPDATE session_progress_cards SET steps_json = ?").run("{");
    const malformed = db.prepare("SELECT * FROM session_progress_cards").get();
    expect(() => writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 2 })).toThrow(
      SyntaxError,
    );
    expect(db.prepare("SELECT * FROM session_progress_cards").get()).toEqual(malformed);
    db.prepare("UPDATE session_progress_cards SET steps_json = ?").run(
      JSON.stringify([{ step: "Done", status: "completed" }]),
    );

    expect(writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 2 })).toEqual({
      card: expect.objectContaining({ revision: 1 }),
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).not.toBeNull();
    expect(writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 1 })).toEqual({
      cleared: true,
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();

    expect(
      writeSessionProgressCard(db, SESSION_KEY, {
        steps: [{ step: "New work", status: "in_progress" }],
      }),
    ).toEqual({
      card: expect.objectContaining({ revision: 3 }),
    });
    expect(writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 1 })).toEqual({
      card: expect.objectContaining({ revision: 3 }),
    });
  });

  it("dismisses active and note-only cards at the expected revision", () => {
    writeSessionProgressCard(db, SESSION_KEY, { steps: STEPS });
    expect(writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 1 })).toEqual({
      cleared: true,
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
    expect(writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 2 })).toEqual({
      card: null,
    });
    expect(db.prepare("SELECT revision FROM session_progress_cards").get()?.revision).toBe(2);

    writeSessionProgressCard(db, SESSION_KEY, { markdown: "Still relevant" });
    const current = readSessionProgressCard(db, SESSION_KEY);
    expect(writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 1 })).toEqual({
      card: current,
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toEqual(current);
    expect(writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 3 })).toEqual({
      cleared: true,
    });
    expect(readSessionProgressCard(db, SESSION_KEY)).toBeNull();
  });

  it.each(["revision", "created_at", "updated_at"] as const)(
    "rejects unsafe %s before payload decoding or mutation",
    (column) => {
      writeSessionProgressCard(db, SESSION_KEY, { markdown: "Existing", steps: STEPS });
      db.prepare(`UPDATE session_progress_cards SET ${column} = ?, steps_json = ?`).run(
        9007199254740993n,
        "{",
      );
      const inspect = db.prepare("SELECT * FROM session_progress_cards");
      inspect.setReadBigInts(true);
      const before = inspect.get();
      const operations = {
        replace: () => writeSessionProgressCard(db, SESSION_KEY, { markdown: "Replacement" }),
        clear: () => writeSessionProgressCard(db, SESSION_KEY, {}),
        reset: () =>
          runSqliteImmediateTransactionSync(db, () =>
            clearSessionProgressCardForReset(db, SESSION_KEY),
          ),
        dismiss: () => writeSessionProgressCard(db, SESSION_KEY, { expectedRevision: 2 }),
      };
      for (const [name, operation] of Object.entries(operations)) {
        expect(operation, name).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
        expect(inspect.get(), name).toEqual(before);
      }
    },
  );
});
