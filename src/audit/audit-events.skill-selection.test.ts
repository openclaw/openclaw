import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getOpenClawStatePredecessorSchema } from "../state/openclaw-state-schema-runtime.js";
import {
  listAuditEvents,
  pruneExpiredAuditEventsInDatabase,
  recordAuditEventInDatabase,
} from "./audit-event-store.js";
import { pruneExpiredSkillSelectionAuditEvents } from "./audit-event-store.skill-selection-storage.js";
import { recordSkillSelectionAuditEvent } from "./audit-event-store.skill-selection-storage.js";
import type { AuditEventInput, SkillSelectionAuditEventInput } from "./audit-event-types.js";

const tempDirs: string[] = [];
const AUDIT_EVENT_MAX_ROWS_CONTRACT = 100_000;
const AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT = 1_024;
const AUDIT_EVENT_RETENTION_MS_CONTRACT = 30 * 24 * 60 * 60_000;

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-") } };
}

function auditInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  const input = {
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  } as AuditEventInput;
}

function skillSelectionInput(
  overrides: Partial<SkillSelectionAuditEventInput> = {},
): SkillSelectionAuditEventInput {
  const input: SkillSelectionAuditEventInput = {
    sourceId: "skill-selection:2",
    sourceSequence: 2,
    occurredAt: Date.now(),
    kind: "skill_selection",
    action: "skill.selection.observed",
    status: "observed",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    toolName: "debug-toolkit",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  };
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("audit event skill-selection persistence", () => {
  it("stores skill selection outside the legacy audit_events table while preserving activity pagination", async () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const auditDatabase = { ...database, database: openOpenClawStateDatabase(database) };
    recordAuditEventInDatabase(auditInput({ occurredAt: now, sourceSequence: 1 }), auditDatabase);
    const skill = recordAuditEventInDatabase(
      skillSelectionInput({ occurredAt: now + 1, sourceSequence: 2 }),
      auditDatabase,
    );
    recordAuditEventInDatabase(
      auditInput({
        occurredAt: now + 2,
        sourceSequence: 3,
        action: "agent.run.finished",
        status: "succeeded",
      }),
      auditDatabase,
    );

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'skill_selection'").get(),
    ).toEqual({ count: 0 });
    expect(db.prepare("SELECT tool_name FROM audit_skill_selection_events").get()).toEqual({
      tool_name: "debug-toolkit",
    });

    const legacy = await listAuditEvents({ database, limit: 10 });
    expect(legacy.events.map((event) => event.kind)).toEqual(["agent_run", "agent_run"]);

    const first = await listAuditEvents({
      database,
      limit: 2,
      filters: { includeSkillSelections: true },
    });
    expect(first.events.map((event) => event.sourceSequence)).toEqual([3, 2]);
    expect(first.events[1]).toMatchObject({
      kind: "skill_selection",
      sequence: skill?.sequence,
      sourceSequence: 2,
      redaction: "metadata_only",
      actorType: "agent",
      actorId: "main",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "debug-toolkit",
    });
    expect(first.nextCursor).toBe(skill?.sequence);

    const second = await listAuditEvents({
      database,
      limit: 2,
      cursor: first.nextCursor,
      filters: { includeSkillSelections: true },
    });
    expect(second.events.map((event) => event.sourceSequence)).toEqual([1]);
    expect(second.nextCursor).toBeUndefined();

    const skillOnly = await listAuditEvents({
      database,
      limit: 10,
      filters: { kind: "skill_selection" },
    });
    expect(skillOnly.events).toEqual([expect.objectContaining({ kind: "skill_selection" })]);
  });

  it("upgrades a v2026.11.3 database preserving settings and audit rows", async () => {
    // Simulate an installed v2026.11.3 database (schema v39, no companion
    // table) with stored settings and one audit row, then open it with the
    // current build the way a real upgrade would.
    const options = {
      env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-upgrade-") },
    };
    const pathname = resolveOpenClawStateSqlitePath(options.env);
    mkdirSync(path.dirname(pathname), { recursive: true });
    const storedAt = Date.now() - 60_000;
    const setup = new DatabaseSync(pathname);
    try {
      setup.exec(getOpenClawStatePredecessorSchema(39));
      setup.exec(`PRAGMA user_version = 39;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', 39, 1, 1);`);
      setup.exec(`INSERT INTO audit_events (event_id, source_id, schema_version, source_sequence,
        occurred_at, kind, action, status, actor_type, actor_id, agent_id, session_key, session_id, run_id)
        VALUES ('legacy-event-1', 'run-legacy:1:${storedAt}:agent.run.started', 1, 1, ${storedAt},
        'agent_run', 'agent.run.started', 'started', 'agent', 'main', 'main',
        'agent:main:main', 'session-legacy', 'run-legacy')`);
    } finally {
      setup.close();
    }

    const auditDatabase = { ...options, database: openOpenClawStateDatabase(options) };
    // The upgrade migrates 39 -> 40 while the stored settings row survives.
    expect(auditDatabase.database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 40,
    });
    expect(
      auditDatabase.database.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: 40 });
    const legacy = await listAuditEvents({ database: options, limit: 10 });
    expect(legacy.events.map((event) => event.eventId)).toEqual(["legacy-event-1"]);

    const skill = recordAuditEventInDatabase(
      skillSelectionInput({ occurredAt: Date.now(), sourceSequence: 2 }),
      auditDatabase,
    );
    expect(skill?.kind).toBe("skill_selection");
    // The shared sequence continues after the stored row.
    expect(skill?.sequence).toBe(2);

    const page = await listAuditEvents({
      database: options,
      limit: 10,
      filters: { includeSkillSelections: true },
    });
    expect(page.events.map((event) => [event.kind, event.sourceSequence])).toEqual([
      ["skill_selection", 2],
      ["agent_run", 1],
    ]);
    // The stored row survives the upgrade untouched.
    expect(page.events[1]).toMatchObject({ eventId: "legacy-event-1", sequence: 1 });
  });

  it("returns fresh ledger sequences after companion allocation consumes a sequence", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const auditDatabase = { ...database, database: openOpenClawStateDatabase(database) };
    const first = recordAuditEventInDatabase(
      auditInput({ occurredAt: now, sourceSequence: 1 }),
      auditDatabase,
    );
    expect(first?.sequence).toBe(1);
    // Second ledger row warms the single-statement retention cache.
    const second = recordAuditEventInDatabase(
      auditInput({ occurredAt: now + 1, sourceSequence: 2 }),
      auditDatabase,
    );
    expect(second?.sequence).toBe(2);
    // Companion allocation consumes the shared sequence outside the retention
    // fast path, so the cached high-water mark must be dropped here.
    const skill = recordAuditEventInDatabase(
      skillSelectionInput({ occurredAt: now + 2, sourceSequence: 3 }),
      auditDatabase,
    );
    expect(skill?.sequence).toBe(3);
    const third = recordAuditEventInDatabase(
      auditInput({
        occurredAt: now + 3,
        sourceSequence: 4,
        action: "agent.run.finished",
        status: "succeeded",
      }),
      auditDatabase,
    );
    // A stale cache would report sequence 3 while SQLite stores the row at 4.
    expect(third?.sequence).toBe(4);
    const { db } = openOpenClawStateDatabase(database);
    expect(db.prepare("SELECT sequence FROM audit_events ORDER BY sequence").all()).toEqual([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 4 },
    ]);
  });

  it("prunes expired skill selection records during bounded audit maintenance", async () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const { db } = openOpenClawStateDatabase(database);
    recordAuditEventInDatabase(skillSelectionInput({ occurredAt }), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    db.prepare("DELETE FROM audit_skill_selection_events").run();
    const insert = db.prepare(
      `INSERT INTO audit_skill_selection_events (
         sequence, event_id, source_id, source_sequence, occurred_at, action, status,
         actor_type, actor_id, agent_id, run_id, tool_name
       ) VALUES (?, ?, ?, ?, ?, 'skill.selection.observed', 'observed',
                 'agent', 'main', 'main', ?, 'debug-toolkit')`,
    );
    for (let index = 0; index < AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT + 1; index += 1) {
      insert.run(
        index + 1,
        `skill-event-${index}`,
        `skill-source-${index}`,
        index + 1,
        occurredAt,
        `run-${index}`,
      );
    }
    const expiredAt = occurredAt + AUDIT_EVENT_RETENTION_MS_CONTRACT + 1;

    expect(
      (
        await listAuditEvents({
          database,
          limit: 10,
          now: expiredAt,
          filters: { kind: "skill_selection" },
        })
      ).events,
    ).toEqual([]);
    expect(
      pruneExpiredAuditEventsInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now: expiredAt,
      }),
    ).toBe(AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_skill_selection_events").get()).toEqual({
      count: 1,
    });
    expect(
      pruneExpiredAuditEventsInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now: expiredAt,
      }),
    ).toBe(1);
    expect(
      pruneExpiredAuditEventsInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
        now: expiredAt,
      }),
    ).toBe(0);
  });

  it("caps skill selection companion rows in bounded batches", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const { db } = openOpenClawStateDatabase(database);
    // Establish the companion schema without warming the per-connection
    // row-count cache, mirroring how the canonical ledger cap test seeds
    // rows before the first counted insert.
    pruneExpiredSkillSelectionAuditEvents({ db, retainedAfter: occurredAt });
    db.prepare(
      `WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
            numbers(n) AS (
              SELECT 1 + a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d
              FROM digits a, digits b, digits c, digits d, digits e, digits f
            )
       INSERT INTO audit_skill_selection_events (
         sequence, event_id, source_id, source_sequence, occurred_at, action, status,
         actor_type, actor_id, agent_id, run_id, tool_name
       )
       SELECT n, 'skill-event-' || n, 'skill-source-' || n, n, ? + n,
              'skill.selection.observed', 'observed', 'agent', 'main', 'main',
              'run-' || n, 'debug-toolkit'
       FROM numbers
       WHERE n <= ?`,
    ).run(occurredAt, AUDIT_EVENT_MAX_ROWS_CONTRACT + 1);
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_events'").run(
      AUDIT_EVENT_MAX_ROWS_CONTRACT + 1,
    );

    expect(
      recordAuditEventInDatabase(
        skillSelectionInput({
          sourceSequence: AUDIT_EVENT_MAX_ROWS_CONTRACT + 2,
          occurredAt: occurredAt + AUDIT_EVENT_MAX_ROWS_CONTRACT + 2,
        }),
        { ...database, database: openOpenClawStateDatabase(database) },
      ),
    ).toBeDefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_skill_selection_events").get()).toEqual({
      count: AUDIT_EVENT_MAX_ROWS_CONTRACT - AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT,
    });
  });

  it("accounts warm-cache expiry exactly once through overflow", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const { db } = openOpenClawStateDatabase(database);
    pruneExpiredSkillSelectionAuditEvents({ db, retainedAfter: occurredAt });
    // Seed MAX - 10 fresh rows, then warm the per-connection count honestly
    // with 10 API inserts so the cache reads exactly MAX.
    db.prepare(
      `WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
            numbers(n) AS (
              SELECT 1 + a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d
              FROM digits a, digits b, digits c, digits d, digits e, digits f
            )
       INSERT INTO audit_skill_selection_events (
         sequence, event_id, source_id, source_sequence, occurred_at, action, status,
         actor_type, actor_id, agent_id, run_id, tool_name
       )
       SELECT n, 'warm-event-' || n, 'warm-source-' || n, n, ? + n,
              'skill.selection.observed', 'observed', 'agent', 'main', 'main',
              'run-' || n, 'debug-toolkit'
       FROM numbers
       WHERE n <= ?`,
    ).run(occurredAt, AUDIT_EVENT_MAX_ROWS_CONTRACT - 10);
    let freshCounter = 0;
    const insertFresh = (tag: string) => {
      freshCounter += 1;
      return recordAuditEventInDatabase(
        skillSelectionInput({
          sourceId: `warm-api-${tag}`,
          sourceSequence: AUDIT_EVENT_MAX_ROWS_CONTRACT + 10 + freshCounter,
          occurredAt: Date.now(),
        }),
        { ...database, database: openOpenClawStateDatabase(database) },
      );
    };
    for (let index = 0; index < 10; index += 1) {
      expect(insertFresh(`seed-${index}`)).toBeDefined();
    }
    // Expire the 1,030 oldest rows, then insert past the cap: exact
    // single-subtraction accounting trims to MAX - 1,024. Subtracting the
    // expiry twice would leave the cache 1,030 low and skip the trim.
    db.prepare(
      "UPDATE audit_skill_selection_events SET occurred_at = 0 WHERE sequence <= 1030",
    ).run();
    expect(insertFresh("overflow-0")).toBeDefined();
    for (let index = 1; index <= 1030; index += 1) {
      expect(insertFresh(`overflow-${index}`)).toBeDefined();
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_skill_selection_events").get()).toEqual({
      count: AUDIT_EVENT_MAX_ROWS_CONTRACT - AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT,
    });
  });

  it("drops tentative companion counts when their batch rolls back", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const { db } = openOpenClawStateDatabase(database);
    const auditDatabase = { ...database, database: openOpenClawStateDatabase(database) };
    const countRows = () =>
      (
        db.prepare("SELECT COUNT(*) AS count FROM audit_skill_selection_events").get() as {
          count: number;
        }
      ).count;
    // Seed MAX - 1 fresh rows with a cold count cache, then one API insert
    // brings ledger and cache honestly to MAX.
    db.prepare(
      `WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
            numbers(n) AS (
              SELECT 1 + a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d
              FROM digits a, digits b, digits c, digits d, digits e, digits f
            )
       INSERT INTO audit_skill_selection_events (
         sequence, event_id, source_id, source_sequence, occurred_at, action, status,
         actor_type, actor_id, agent_id, run_id, tool_name
       )
       SELECT n, 'rollback-event-' || n, 'rollback-source-' || n, n, ? + n,
              'skill.selection.observed', 'observed', 'agent', 'main', 'main',
              'run-' || n, 'debug-toolkit'
       FROM numbers
       WHERE n <= ?`,
    ).run(occurredAt, AUDIT_EVENT_MAX_ROWS_CONTRACT - 1);
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_events'").run(
      AUDIT_EVENT_MAX_ROWS_CONTRACT - 1,
    );
    expect(
      recordAuditEventInDatabase(
        skillSelectionInput({
          sourceId: "rollback-api-fill",
          sourceSequence: AUDIT_EVENT_MAX_ROWS_CONTRACT,
          occurredAt: Date.now(),
        }),
        auditDatabase,
      ),
    ).toBeDefined();
    expect(countRows()).toBe(AUDIT_EVENT_MAX_ROWS_CONTRACT);

    // A batch that writes then rolls back must not leave its tentative
    // (+1 insert, overflow trim) count behind: the rows are gone.
    const retainedAfter = Date.now() - AUDIT_EVENT_RETENTION_MS_CONTRACT;
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        recordSkillSelectionAuditEvent(
          skillSelectionInput({
            sourceId: "rollback-api-doomed",
            sourceSequence: AUDIT_EVENT_MAX_ROWS_CONTRACT + 1,
            occurredAt: Date.now(),
          }),
          auditDatabase.database.db,
          retainedAfter,
        );
        throw new Error("simulated batch failure");
      }, auditDatabase),
    ).toThrow("simulated batch failure");
    expect(countRows()).toBe(AUDIT_EVENT_MAX_ROWS_CONTRACT);

    // The next insert re-derives the honest count: with the cap reached it
    // trims to MAX - 1,024. A stale tentative count would skip the trim and
    // store 100,001 rows.
    expect(
      recordAuditEventInDatabase(
        skillSelectionInput({
          sourceId: "rollback-api-after",
          sourceSequence: AUDIT_EVENT_MAX_ROWS_CONTRACT + 2,
          occurredAt: Date.now(),
        }),
        auditDatabase,
      ),
    ).toBeDefined();
    expect(countRows()).toBe(AUDIT_EVENT_MAX_ROWS_CONTRACT - AUDIT_EVENT_PRUNE_BATCH_ROWS_CONTRACT);
  });
});
