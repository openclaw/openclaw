import type { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  waitForSessionTranscriptProjection,
  type SessionTranscriptReadScope,
} from "./session-accessor.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventCount,
} from "./session-accessor.sqlite-history-events.js";
import { insertSyntheticHistory } from "./session-accessor.sqlite-history.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function readHistoryWithMarkerPlan(
  database: OpenClawAgentDatabase,
  scope: SessionTranscriptReadScope,
) {
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  const prepare = database.db.prepare.bind(database.db);
  const markerStatements: StatementSync[] = [];
  const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    if (statement.columns().some(({ name }) => name === "following_message_position")) {
      markerStatements.push(statement);
    }
    return statement;
  });
  try {
    const page = readRecentSessionTranscriptHistoryEvents(scope, {
      maxMessages: 20,
      maxLines: 20,
      maxBytes: 1_000_000,
    });
    expect(markerStatements).toHaveLength(1);
    const plan = prepare(`EXPLAIN QUERY PLAN ${markerStatements[0]!.expandedSQL}`).all();
    const drivingSearch = plan.find(
      ({ detail }) => typeof detail === "string" && detail.startsWith("SEARCH "),
    )?.detail;
    return { page, drivingSearch };
  } finally {
    spy.mockRestore();
  }
}

it.each([false, true])("keeps history marker reads selective (analyzed=%s)", async (analyzed) => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-history-query-plan-") },
    sessionId: "history-events-test",
    sessionKey: "agent:main:history-events-test",
  };
  const denseScope = {
    ...scope,
    sessionId: "dense-marker-history",
    sessionKey: "agent:main:dense-marker-history",
  };
  const plainScope = {
    ...scope,
    sessionId: "plain-message-history",
    sessionKey: "agent:main:plain-message-history",
  };
  const compactionScope = {
    ...scope,
    sessionId: "dense-compaction-history",
    sessionKey: "agent:main:dense-compaction-history",
  };
  for (const target of [scope, denseScope, plainScope, compactionScope]) {
    await persistSessionTranscriptTurn(target, {
      messages: [transcriptMessage("seed", null, { role: "user", content: "seed" })],
      touchSessionEntry: false,
    });
  }
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  const messageCount = 10_000;
  const markerIds = Array.from({ length: 10 }, (_, index) => `rare-marker-${index}`);
  insertSyntheticHistory(database, scope.sessionId, messageCount);
  // Session/type averages from the dense peer can favor scanning every active row
  // instead of selecting and sorting this session's few markers.
  insertSyntheticHistory(database, denseScope.sessionId, messageCount, true, "custom_message");
  insertSyntheticHistory(database, plainScope.sessionId, messageCount);
  insertSyntheticHistory(database, compactionScope.sessionId, messageCount / 2, true);
  let parentId = `synthetic-message-${messageCount + 1}`;
  for (const id of markerIds) {
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id,
      parentId,
      timestamp: "2026-09-13T00:00:00.000Z",
      summary: "sparse history marker",
    });
    parentId = id;
  }
  if (analyzed) {
    database.db.exec("ANALYZE");
  }
  const { page, drivingSearch } = readHistoryWithMarkerPlan(database, scope);
  const firstSequence = messageCount - markerIds.length + 2;
  expect(page.totalMessages).toBe(messageCount + markerIds.length + 1);
  expect(page.events.map(({ event }) => event)).toEqual(
    [
      ...Array.from({ length: 10 }, (_, index) => `synthetic-message-${firstSequence + index}`),
      ...markerIds,
    ].map((id) => expect.objectContaining({ id })),
  );
  expect(page.events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: 20 }, (_, index) => firstSequence + index),
  );
  expect(drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);

  // The same stored markers must stop driving reads once their branch is inactive.
  await appendTranscriptEvent(denseScope, {
    type: "custom_message",
    id: "branch-marker",
    parentId: "seed",
    customType: "synthetic-notice",
    content: "Current branch marker",
    display: true,
  });
  const branchIds = Array.from({ length: 20 }, (_, index) => `branch-message-${index}`);
  await persistSessionTranscriptTurn(denseScope, {
    messages: branchIds.map((id, index) =>
      transcriptMessage(id, index === 0 ? "branch-marker" : branchIds[index - 1]!, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: id,
      }),
    ),
    touchSessionEntry: false,
  });
  await waitForSessionTranscriptProjection(denseScope);
  if (analyzed) {
    database.db.exec("ANALYZE");
  }
  const branch = readHistoryWithMarkerPlan(database, denseScope);
  expect(branch.page.totalMessages).toBe(22);
  expect(branch.page.events.map(({ event }) => event)).toEqual(
    branchIds.map((id) => expect.objectContaining({ id })),
  );
  expect(branch.page.events.map(({ seq }) => seq)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 3),
  );
  expect(branch.drivingSearch).toMatch(/^SEARCH active .*\(session_id=\?/u);
  expect(readSessionTranscriptHistoryEventCount(denseScope)).toBe(22);

  // Discarded ordinary messages do not justify scanning a branch with few markers.
  await appendTranscriptEvent(plainScope, {
    type: "compaction",
    id: "sparse-branch-marker",
    parentId: "seed",
    summary: "Current branch marker",
  });
  await persistSessionTranscriptTurn(plainScope, {
    messages: branchIds.map((id, index) =>
      transcriptMessage(id, index === 0 ? "sparse-branch-marker" : branchIds[index - 1]!, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: id,
      }),
    ),
    touchSessionEntry: false,
  });
  await waitForSessionTranscriptProjection(plainScope);
  if (analyzed) {
    database.db.exec("ANALYZE");
  }
  const sparseBranch = readHistoryWithMarkerPlan(database, plainScope);
  expect(sparseBranch.page.events.map(({ event }) => event)).toEqual(
    branchIds.map((id) => expect.objectContaining({ id })),
  );
  expect(sparseBranch.page.events.map(({ seq }) => seq)).toEqual(
    branch.page.events.map(({ seq }) => seq),
  );
  expect(sparseBranch.page.totalMessages).toBe(22);
  expect(sparseBranch.drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);
  expect(readSessionTranscriptHistoryEventCount(plainScope)).toBe(22);
});
