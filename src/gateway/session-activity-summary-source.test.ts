import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { SessionActivitySummaryBatchResult } from "../config/sessions/activity-summary-source.types.js";
import {
  ACTIVITY_SUMMARY_FORMAT_REVISION,
  type SessionActivitySummary,
} from "../config/sessions/activity-summary.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../config/sessions/session-accessor.sqlite-active-context.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  createSessionActorReplica,
  retainSessionActorTranscriptReplica,
} from "../config/sessions/session-actor-replica.js";
import { seedSessionActorTranscriptContext } from "../config/sessions/session-actor-transcript-replica.js";
import { withActor } from "../config/sessions/session-actor-worker.test-support.js";
import type { PreparedSessionTranscriptHydration } from "../config/sessions/session-history-read.types.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { readActivitySummaryBatchFromReplica } from "./session-activity-summary-replica.js";
import { readActivitySummarySource } from "./session-activity-summary-source.js";
import { readActivitySummaryBatch } from "./session-activity-summary-source.worker.js";

// mock-isolation: The fixture owns its database and transcript maintenance lifetime.
vi.mock("../config/sessions/session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture controls archival rather than launching disk-budget maintenance.
vi.mock("../config/sessions/session-history-eviction.js", () => ({
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

function summaryFacts(source: SessionActivitySummaryBatchResult) {
  if (!source) {
    throw new Error("Expected a complete activity summary batch");
  }
  return {
    ...source,
    snapshot: {
      totalMessages: source.snapshot.totalMessages,
      activeLeafEntryId: source.snapshot.activeLeafEntryId,
      generation: source.snapshot.snapshot.generation,
    },
    page: {
      events: source.page.events.map(({ event }) => event),
      scannedMessages: source.page.scannedMessages,
    },
  };
}

it("reuses complete actor context with the worker's byte bounds, anchors and role-aware omissions", async () => {
  await withActor(async (f) => {
    if (f.target.database.kind !== "file") {
      throw new Error("Summary replica fixture requires a durable actor");
    }
    const exactCapEvent = {
      type: "message",
      id: "message-5",
      parentId: "message-4",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "assistant", content: "" },
    };
    exactCapEvent.message.content = "x".repeat(
      128 * 1024 - 1 - Buffer.byteLength(JSON.stringify(exactCapEvent)),
    );
    const content = [
      { role: "toolResult", content: "t".repeat(128 * 1024) },
      { role: "user", content: "Small question" },
      { role: "assistant", content: "a".repeat(128 * 1024) },
      { role: "user", content: "é".repeat(40 * 1024) },
      { role: "assistant", content: "é".repeat(40 * 1024) },
      exactCapEvent.message,
      { ...exactCapEvent.message, content: `${exactCapEvent.message.content}x` },
      ...Array.from({ length: 64 }, (_, index) => ({ role: "user", content: `Question ${index}` })),
    ];
    const events = content.map((message, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? "runtime-context" : `message-${index - 1}`,
      timestamp: "2026-01-01T00:00:00Z",
      message,
    }));
    runSqliteImmediateTransactionSync(f.database.db, () => {
      writeSessionEntry(f.database, f.target.sessionKey, {
        sessionId: f.scope.sessionId,
        updatedAt: 1,
      });
      replaceSqliteTranscriptEventsInTransaction(f.database, f.scope, [
        {
          type: "session",
          id: f.scope.sessionId,
          version: 3,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/synthetic",
        },
        {
          type: "custom",
          id: "model-snapshot",
          parentId: null,
          customType: "model-snapshot",
          data: { provider: "synthetic", modelId: "test-model" },
        },
        {
          type: "custom_message",
          id: "runtime-context",
          parentId: "model-snapshot",
          customType: "openclaw.runtime-context",
          content: "Current synthetic runtime facts",
          display: false,
        },
        ...events,
      ]);
    });
    const replica = createSessionActorReplica({
      target: { ...f.target, database: f.target.database },
      lifetime: { assertCurrent() {}, assertReadable() {} },
      currentGeneration: () => "summary-fixture",
    });
    try {
      const limits = { maxBytes: 1024 * 1024, maxEvents: 100 };
      let residentRows: Extract<
        PreparedSessionTranscriptHydration,
        { kind: "bounded" }
      >["residentRows"];
      const snapshot = readSessionTranscriptBoundedActiveContextCore(f.scope, {
        ...limits,
        onRead: (_projection, rows) => {
          residentRows = rows;
        },
      });
      const hot = f.read();
      expect(replica.beginRead()(hot)).toBe(true);
      const retained = seedSessionActorTranscriptContext(
        undefined,
        hot,
        { kind: "bounded", snapshot, residentRows },
        limits,
      );
      if (!retained) {
        throw new Error("Canonical bounded context did not seed the actor replica");
      }
      retainSessionActorTranscriptReplica(hot, retained);
      const previous = (coveredMessages: number): SessionActivitySummary => ({
        version: 1,
        formatRevision: 2,
        text: "Earlier work",
        updatedAt: 1,
        sessionId: f.scope.sessionId,
        generation: hot.transcript.version.generation,
        maxSeq: coveredMessages,
        leafEntryId: `message-${coveredMessages - 1}`,
        coveredMessages,
        totalMessages: events.length,
        omittedContent: true,
      });
      for (const [prior, expected] of [
        [undefined, { covered: 0, page: { scannedMessages: 1, events: [] }, omitted: false }],
        [
          previous(1),
          { covered: 1, page: { scannedMessages: 1, events: [events[1]] }, omitted: false },
        ],
        [previous(2), { covered: 2, page: { scannedMessages: 1, events: [] }, omitted: true }],
        [
          previous(3),
          { covered: 3, page: { scannedMessages: 1, events: [events[3]] }, omitted: true },
        ],
        [
          { ...previous(5), omittedContent: false },
          { covered: 5, page: { scannedMessages: 1, events: [events[5]] }, omitted: false },
        ],
        [previous(6), { covered: 6, page: { scannedMessages: 1, events: [] }, omitted: true }],
        [previous(7), { covered: 7, page: { scannedMessages: 64 }, omitted: true }],
        [
          { ...previous(1), formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION },
          { covered: 1, omitted: true },
        ],
        [
          { ...previous(1), generation: "obsolete" },
          { previous: undefined, covered: 0 },
        ],
        [
          { ...previous(1), leafEntryId: "off-path" },
          { previous: undefined, covered: 0 },
        ],
        [previous(events.length + 1), { previous: undefined, covered: 0 }],
      ] as const) {
        const input = { scope: f.scope, previous: prior };
        const resident = summaryFacts(readActivitySummaryBatchFromReplica(input));
        expect(resident).toMatchObject(expected);
        expect(resident).toEqual(summaryFacts(readActivitySummaryBatch(input)));
      }

      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(f.database.db),
        ["read"],
        () => "read",
      );
      try {
        const source = await readActivitySummarySource({
          scope: f.scope,
          previous: previous(1),
          assertCurrent() {},
        });
        expect(source?.notes).toEqual(["user: Small question"]);
        expect(reads.counts.read).toBe(0);
        const event = source?.page.events[0]?.event;
        if (!isRecord(event) || !isRecord(event.message)) {
          throw new Error("Expected a selected user message");
        }
        event.message.content = "caller mutation";
        expect(
          summaryFacts(
            readActivitySummaryBatchFromReplica({ scope: f.scope, previous: previous(1) }),
          ).page.events,
        ).toEqual([events[1]]);
      } finally {
        reads.restore();
      }
    } finally {
      replica.close();
    }
  });
});
