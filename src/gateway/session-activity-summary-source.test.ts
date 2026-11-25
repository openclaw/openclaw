import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
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
import { summaryFacts } from "../config/sessions/session-actor-transcript.test-support.js";
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

it("reuses complete actor context with the worker's byte bounds, anchors and role-aware omissions", () =>
  withActor(async (f) => {
    assert(f.target.database.kind === "file", "Summary replica requires a durable actor");
    const makeEvent = (index: number, role: string, content: string) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? "runtime-context" : `message-${index - 1}`,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role, content },
    });
    const exactCapEvent = makeEvent(5, "assistant", "");
    exactCapEvent.message.content = "x".repeat(
      128 * 1024 - 1 - Buffer.byteLength(JSON.stringify(exactCapEvent)),
    );
    const events = [
      makeEvent(0, "toolResult", "t".repeat(128 * 1024)),
      makeEvent(1, "user", "Small question"),
      makeEvent(2, "assistant", "a".repeat(128 * 1024)),
      makeEvent(3, "user", "é".repeat(40 * 1024)),
      makeEvent(4, "assistant", "é".repeat(40 * 1024)),
      exactCapEvent,
      makeEvent(6, "assistant", `${exactCapEvent.message.content}x`),
      ...Array.from({ length: 64 }, (_, index) =>
        makeEvent(index + 7, "user", `Question ${index}`),
      ),
    ];
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
      assert(retained, "Canonical bounded context did not seed the actor replica");
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
      const page = (covered: number, selected: unknown[], omitted: boolean) => ({
        covered,
        scannedMessages: 1,
        events: selected,
        omitted,
      });
      const readReplica = (prior?: SessionActivitySummary) =>
        summaryFacts(readActivitySummaryBatchFromReplica({ scope: f.scope, previous: prior }));
      for (const [prior, expected] of [
        [undefined, page(0, [], false)],
        [previous(1), page(1, [events[1]], false)],
        [previous(2), page(2, [], true)],
        [previous(3), page(3, [events[3]], true)],
        [{ ...previous(5), omittedContent: false }, page(5, [events[5]], false)],
        [previous(6), page(6, [], true)],
        [previous(7), { covered: 7, scannedMessages: 64, omitted: true }],
        [
          { ...previous(1), formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION },
          { covered: 1, omitted: true },
        ],
        ...[
          { ...previous(1), generation: "obsolete" },
          { ...previous(1), leafEntryId: "off-path" },
          previous(events.length + 1),
        ].map((invalid) => [invalid, { previous: undefined, covered: 0 }] as const),
      ] as const) {
        const input = { scope: f.scope, previous: prior };
        const resident = readReplica(prior);
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
        assert(isRecord(event) && isRecord(event.message), "Expected a selected user message");
        event.message.content = "caller mutation";
        expect(readReplica(previous(1)).events).toEqual([events[1]]);
      } finally {
        reads.restore();
      }
    } finally {
      replica.close();
    }
  }));
