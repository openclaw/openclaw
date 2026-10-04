import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  listAuditEvents,
  pruneExpiredAuditEventsInDatabase,
  recordAuditEventInDatabase,
} from "./audit-event-store.js";
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
    recordAuditEventInDatabase(skillSelectionInput({ occurredAt }), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    db.prepare("DELETE FROM audit_skill_selection_events").run();
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
});
