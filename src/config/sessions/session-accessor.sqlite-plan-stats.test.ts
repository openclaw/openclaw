import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTranscriptPlanStatistics,
  captureTranscriptSql,
  seedTranscriptPlanStatsFixture,
} from "../../../test/helpers/transcript-plan-stats.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { withRecentSessionTranscriptActiveEventsInSnapshot } from "./session-accessor.sqlite-active-events-read.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { readPreviousIndexedTranscriptEventSync } from "./session-accessor.sqlite-suffix-read.js";
import { readTranscriptVisibleTailEntryIdInTransaction } from "./session-accessor.sqlite-transcript-parent.js";

const dirs = useSessionStoreTempDirs(afterAll, "transcript-plan-stats-");
let database: ReturnType<typeof openOpenClawAgentDatabase>;
let db: ReturnType<typeof requireNativeSqliteDatabase>;
let projection: CurrentTranscriptProjection;
const scope = {
  agentId: "synthetic",
  sessionId: "long",
  sessionKey: "agent:synthetic:long",
  env: {} as NodeJS.ProcessEnv,
};
beforeAll(() => {
  scope.env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make() };
  database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  db = requireNativeSqliteDatabase(database.db);
  seedTranscriptPlanStatsFixture(db);
  readCurrentProjectionSnapshot(database, scope, (value) => {
    projection = value;
  });
});

function expectActiveProbes(read: () => unknown, select: (columns: string[]) => boolean) {
  const { result, queries } = captureTranscriptSql(db, read);
  const selected = queries.filter((query) => select(query.columns));
  expect(selected.length).toBeGreaterThan(0);
  for (const query of selected) {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all()
      .map((row) => String(row.detail));
    expect(plan.find((detail) => detail.startsWith("SEARCH "))).toMatch(/^SEARCH active /u);
    expect(plan).toContainEqual(
      expect.stringMatching(/^SEARCH event .*\(session_id=\? AND seq=\?\)/u),
    );
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  }
  return result;
}

describe.each(["none", "analyzed", "team"] as const)("%s statistics", (state) => {
  beforeAll(() => applyTranscriptPlanStatistics(db, state));
  it.each([
    ["long", 3],
    ["dense", 9998],
  ] as const)("reads the latest boundary payload by sequence in %s", (sessionId, boundaryCount) => {
    const { result, queries } = captureTranscriptSql(db, () =>
      runSqliteReadSnapshotSync(database.db, () =>
        readSessionTranscriptBoundedActiveContextCore(
          { ...scope, sessionId, sessionKey: `agent:synthetic:${sessionId}` },
          { maxEvents: 20, maxBytes: 100000, transaction: database },
        ),
      ),
    );
    expect(result).toMatchObject({ boundaryCount, totalEvents: 20000 });
    const boundaries = queries.filter(({ columns }) => columns.includes("boundary_count"));
    expect(boundaries).toHaveLength(1);
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${boundaries[0]!.sql}`)
      .all()
      .map((row) => String(row.detail));
    expect(plan).toContainEqual(
      expect.stringMatching(/^SEARCH event .*\(session_id=\? AND seq=\?\)/u),
    );
    expect(plan).not.toContainEqual(expect.stringMatching(/^SEARCH event .*\(session_id=\?\)/u));
  });
  it("reads a recent active tail without scanning or sorting payloads", () => {
    expect(
      expectActiveProbes(
        () =>
          withRecentSessionTranscriptActiveEventsInSnapshot(projection, 3, (visit) => {
            const events: unknown[] = [];
            visit((event) => events.push(event));
            return events;
          }),
        (columns) => columns.includes("event_zstd"),
      ),
    ).toMatchObject([{ id: "event-19999" }, { id: "event-19998" }, { id: "event-19997" }]);
  });
  it("reads the visible append parent with one payload probe", () => {
    expect(
      expectActiveProbes(
        () =>
          readTranscriptVisibleTailEntryIdInTransaction(database, scope.sessionId, "event-19999"),
        (columns) => columns.length === 1 && columns.includes("event_json"),
      ),
    ).toBe("event-19999");
  });
  it("selects the previous indexed position before reading its payload", () => {
    for (const before of [3, 10000, 19998]) {
      expect(
        expectActiveProbes(
          () => readPreviousIndexedTranscriptEventSync(scope, before),
          (columns) => columns.includes("seq") && columns.includes("event_json"),
        ),
      ).toMatchObject({ seq: before - 1, event: { id: `event-${before - 1}` } });
    }
    expect(readPreviousIndexedTranscriptEventSync(scope, 0)).toBeUndefined();
    expect(
      readPreviousIndexedTranscriptEventSync(
        { ...scope, sessionId: "dense", sessionKey: "agent:synthetic:dense" },
        10001,
      ),
    ).toMatchObject({ seq: 10000, event: { type: "compaction" } });
    expect(readPreviousIndexedTranscriptEventSync(scope, 10001)).toMatchObject({
      seq: 10000,
      event: { type: "message" },
    });
    db.exec("SAVEPOINT missing_identity");
    try {
      db.prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND seq = ?").run(
        scope.sessionId,
        19997,
      );
      expect(readPreviousIndexedTranscriptEventSync(scope, 19998)).toMatchObject({
        seq: 19996,
        event: { id: "event-19996" },
      });
    } finally {
      db.exec("ROLLBACK TO missing_identity; RELEASE missing_identity");
    }
  });
});
