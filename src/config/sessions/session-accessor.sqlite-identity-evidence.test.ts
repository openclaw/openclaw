import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { readSessionIdentityEvidenceBatch, replaceSessionEntrySync } from "./session-accessor.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([1, 32])("bounds participant reads for %i session identity probes", (count) => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-identity-batch-") };
  const scope = { agentId: "worker-1", env };
  const database = openOpenClawAgentDatabase(scope);
  const probes = Array.from({ length: count }, (_, index) => ({
    ...scope,
    sessionId: `session-${index}`,
    sessionKey: `agent:worker-1:session-${index}`,
    storePath: database.path,
  }));
  for (const probe of probes) {
    replaceSessionEntrySync(probe, { sessionId: probe.sessionId, updatedAt: 1 });
    recordSessionParticipant(probe, {
      identity: { type: "profile", id: "alice" },
      promptedAt: 1,
    });
  }
  const expected = probes.map(({ sessionKey }) => ({ status: "current", sessionKey }));
  expect(readSessionIdentityEvidenceBatch(probes)).toEqual(expected);
  const queries = trackSqliteStatementExecutions(database.db, ["participants"], (sql) =>
    sql.includes('from "session_participants"') ? "participants" : null,
  );
  try {
    expect(readSessionIdentityEvidenceBatch(probes)).toEqual(expected);
    expect(queries.rowCounts.participants).toBe(count);
    expect(queries.counts.participants).toBeGreaterThan(0);
    expect(queries.counts.participants).toBeLessThanOrEqual(2);
  } finally {
    queries.restore();
  }
});
