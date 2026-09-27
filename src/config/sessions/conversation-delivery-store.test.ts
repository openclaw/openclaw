import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelProgressDraftCompositorSnapshot } from "../../channels/progress-draft-compositor.types.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  beginConversationDeliveryOperation,
  findConversationTurnDeliveryByReplyTarget,
  getConversationDeliveryOperation,
  getConversationProgressSnapshot,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
  recordConversationProgressReceipt,
  updateConversationProgressSnapshot,
} from "./conversation-delivery-store.js";
import { resolveConversation } from "./conversation-registry.js";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore as upsertCanonicalSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type LegacyDeliveryFixture = Partial<SessionEntry> & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
};

const upsertSessionEntry = (
  scope: Parameters<typeof upsertCanonicalSessionEntry>[0],
  entry: LegacyDeliveryFixture,
) => upsertCanonicalSessionEntry(scope, normalizeLegacySessionEntryDelivery(entry as SessionEntry));

async function withConversationStore(
  run: (params: {
    scope: { agentId: string; storePath: string };
    conversationRef: string;
  }) => Promise<void> | void,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-conversation-delivery-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const scope = { agentId: "main", storePath };
    try {
      await upsertSessionEntry(
        { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
        {
          sessionId: "reef-session",
          updatedAt: 100,
          chatType: "direct",
          deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
          origin: {
            provider: "reef",
            accountId: "default",
            nativeDirectUserId: "peer-agent",
          },
        },
      );
      await run({
        scope,
        conversationRef: buildConversationRef({
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId: "peer-agent",
        }),
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });
}

describe("conversation delivery store", () => {
  it("reopens old receipts and retains desired progress independently of delivery evidence", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "legacy",
        operationKind: "send",
        conversationRef,
        message: "legacy",
      });
      const legacy = markConversationDeliverySent(scope, "legacy", "legacy-message");
      closeOpenClawAgentDatabasesForTest();
      expect(getConversationDeliveryOperation(scope, "legacy")).toEqual(legacy);
      expect(getConversationProgressSnapshot(scope, "legacy")).toBeUndefined();

      const snapshot: ChannelProgressDraftCompositorSnapshot = {
        lines: [{ kind: "tool", text: "Inspect", label: "Inspect", id: "inspect", complete: true }],
        label: "Working",
        statusHeadline: "Waiting for workers",
        statusHeadlineFormat: "plain",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "in_progress" },
        ],
        preparedBlocks: [{ text: "Waiting for workers", format: "plain" }],
        diffStat: { files: 1, added: 2, removed: 0 },
      };
      recordConversationProgressReceipt(scope, {
        operationId: "progress",
        conversationRef,
        sourceSessionKey: "agent:main:reef:direct:peer-agent",
        message: "original card",
        platformMessageId: "card-message",
        progressSnapshot: snapshot,
        assertCurrent: () => {},
      });
      const receipt = getConversationDeliveryOperation(scope, "progress");
      closeOpenClawAgentDatabasesForTest();
      expect(getConversationDeliveryOperation(scope, "progress")).toEqual(receipt);
      expect(getConversationProgressSnapshot(scope, "progress")).toEqual(snapshot);
      const replied = markConversationDeliveryReplied(scope, {
        operationId: "progress",
        reply: { messageId: "reply", text: "continue", timestamp: 2 },
      });
      const desired: ChannelProgressDraftCompositorSnapshot = {
        ...snapshot,
        statusHeadline: "Finishing",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "completed" },
        ],
      };
      updateConversationProgressSnapshot(scope, {
        operationId: "progress",
        progressSnapshot: desired,
        assertCurrent: () => {},
      });
      closeOpenClawAgentDatabasesForTest();
      expect(getConversationDeliveryOperation(scope, "progress")).toEqual(replied);
      expect(getConversationProgressSnapshot(scope, "progress")).toEqual(desired);
      expect(getConversationDeliveryOperation(scope, "legacy")).toEqual(legacy);
    });
  });

  it("fences progress receipt identity and rolls back stale writes", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      const input = {
        operationId: "guarded-progress",
        conversationRef,
        sourceSessionKey: "agent:main:reef:direct:peer-agent",
        message: "card",
        platformMessageId: "card-message",
        progressSnapshot: { lines: [] },
        assertCurrent: () => {},
      };
      const stale = () => {
        throw new Error("turn superseded");
      };
      expect(() =>
        recordConversationProgressReceipt(scope, { ...input, assertCurrent: stale }),
      ).toThrow("turn superseded");
      expect(getConversationDeliveryOperation(scope, input.operationId)).toBeUndefined();
      expect(getConversationProgressSnapshot(scope, input.operationId)).toBeUndefined();
      recordConversationProgressReceipt(scope, input);
      const receipt = getConversationDeliveryOperation(scope, input.operationId);
      for (const changed of [
        { conversationRef: "another-conversation" },
        { sourceSessionKey: "agent:main:another-turn" },
        { message: "another card" },
        { platformMessageId: "another-message" },
      ]) {
        expect(() => recordConversationProgressReceipt(scope, { ...input, ...changed })).toThrow();
      }
      expect(() =>
        updateConversationProgressSnapshot(scope, {
          operationId: input.operationId,
          progressSnapshot: { lines: ["must not persist"] },
          assertCurrent: stale,
        }),
      ).toThrow("turn superseded");
      expect(getConversationDeliveryOperation(scope, input.operationId)).toEqual(receipt);
      expect(getConversationProgressSnapshot(scope, input.operationId)).toEqual(
        input.progressSnapshot,
      );

      beginConversationDeliveryOperation(scope, {
        ...input,
        operationId: "other-turn",
        operationKind: "turn",
      });
      expect(() =>
        recordConversationProgressReceipt(scope, { ...input, operationId: "other-turn" }),
      ).toThrow("reused with different input");
      beginConversationDeliveryOperation(scope, {
        ...input,
        operationId: "prepared",
        operationKind: "send",
        preparedMessageId: "another-message",
      });
      expect(() =>
        recordConversationProgressReceipt(scope, { ...input, operationId: "prepared" }),
      ).toThrow("conflicts with existing delivery");
      expect(() =>
        updateConversationProgressSnapshot(scope, {
          operationId: "prepared",
          progressSnapshot: input.progressSnapshot,
          assertCurrent: input.assertCurrent,
        }),
      ).toThrow("requires an identified sent receipt");
      markConversationDeliveryUnknown(scope, "prepared");
      expect(() =>
        recordConversationProgressReceipt(scope, { ...input, operationId: "prepared" }),
      ).toThrow("conflicts with existing delivery");
    });
  });

  it("rejects unbounded or private snapshot data without hiding receipts on corrupt optional reads", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      const input = {
        operationId: "bounded-progress",
        conversationRef,
        sourceSessionKey: "agent:main:reef:direct:peer-agent",
        message: "card",
        platformMessageId: "card-message",
        progressSnapshot: { lines: [] },
        assertCurrent: () => {},
      };
      recordConversationProgressReceipt(scope, input);
      const receipt = getConversationDeliveryOperation(scope, input.operationId);
      for (const snapshot of [
        { lines: [], credentials: "not-display-data" },
        { lines: [], callback: () => {} },
        { lines: Array.from({ length: 129 }, () => "line") },
        { lines: ["x".repeat(4097)] },
        { lines: Array.from({ length: 64 }, () => "x".repeat(2048)) },
        { lines: [], plan: [{ step: "Work", status: "failed" }] },
        { lines: [], diffStat: { files: -1, added: 0, removed: 0 } },
      ]) {
        expect(() =>
          updateConversationProgressSnapshot(scope, {
            operationId: input.operationId,
            progressSnapshot: snapshot as ChannelProgressDraftCompositorSnapshot,
            assertCurrent: input.assertCurrent,
          }),
        ).toThrow();
      }
      expect(getConversationDeliveryOperation(scope, input.operationId)).toEqual(receipt);
      expect(getConversationProgressSnapshot(scope, input.operationId)).toEqual(
        input.progressSnapshot,
      );
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
      for (const invalid of ["{broken", '{"lines":[],"callback":"private"}', '{"lines":false}']) {
        database.db
          .prepare("UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?")
          .run(invalid, "conversation-progress", input.operationId);
        expect(getConversationProgressSnapshot(scope, input.operationId)).toBeUndefined();
        expect(getConversationDeliveryOperation(scope, input.operationId)).toEqual(receipt);
      }
    });
  });

  it("validates retry input without recreating a missing operation", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      const input = {
        operationKind: "send" as const,
        conversationRef,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        message: "hello",
      };
      expect(getConversationDeliveryOperation(scope, "missing", input)).toBeUndefined();
      expect(getConversationDeliveryOperation(scope, "missing")).toBeUndefined();
      const begun = beginConversationDeliveryOperation(scope, { operationId: "retry", ...input });
      expect(
        getConversationDeliveryOperation(scope, " retry ", {
          ...input,
          sourceSessionKey: ` ${input.sourceSessionKey} `,
        }),
      ).toEqual(begun.record);
      for (const changed of [
        { operationKind: "turn" as const },
        { conversationRef: "conv_ffffffffffffffffffffffffffffffff" },
        { sourceSessionKey: "agent:main:other" },
        { message: "changed" },
      ]) {
        expect(() =>
          getConversationDeliveryOperation(scope, "retry", { ...input, ...changed }),
        ).toThrow("Conversation delivery operation was reused with different input: retry");
      }
      expect(getConversationDeliveryOperation(scope, "retry")).toEqual(begun.record);
    });
  });

  it("creates idempotent operations and rejects operation-id input reuse", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      const first = beginConversationDeliveryOperation(scope, {
        operationId: "operation-1",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        message: "hello",
        preparedMessageId: "prepared-1",
      });
      const repeated = beginConversationDeliveryOperation(scope, {
        operationId: "operation-1",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        message: "hello",
        preparedMessageId: "ignored-retry-candidate",
      });

      expect(first.created).toBe(true);
      expect(first.record.channel).toBe("reef");
      expect(first.record.sourceSessionKey).toBe("agent:main:telegram:direct:operator");
      expect(repeated).toEqual({ created: false, record: first.record });
      expect(() =>
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "send",
          conversationRef,
          message: "different",
        }),
      ).toThrow("reused with different input");
      expect(() =>
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "turn",
          conversationRef,
          sourceSessionKey: "agent:main:telegram:direct:operator",
          message: "hello",
        }),
      ).toThrow("reused with different input");
      expect(() =>
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "send",
          conversationRef,
          sourceSessionKey: "agent:main:discord:channel:other",
          message: "hello",
        }),
      ).toThrow("reused with different input");
    });
  });

  it("persists queue, platform, and correlated reply evidence", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-2",
        operationKind: "turn",
        conversationRef,
        message: "hello",
        preparedMessageId: "prepared-2",
      });
      expect(markConversationDeliveryQueued(scope, "operation-2", "queue-2")).toMatchObject({
        status: "queued",
        queueId: "queue-2",
      });
      expect(markConversationDeliverySent(scope, "operation-2", "platform-2")).toMatchObject({
        status: "sent",
        platformMessageId: "platform-2",
      });
      const replied = markConversationDeliveryReplied(scope, {
        operationId: "operation-2",
        reply: {
          messageId: "reply-2",
          replyToId: "platform-2",
          text: "ack",
          timestamp: 200,
        },
      });

      expect(replied).toMatchObject({
        status: "replied",
        reply: { messageId: "reply-2", text: "ack" },
      });
      expect(
        findConversationTurnDeliveryByReplyTarget(scope, {
          conversationRef,
          replyToId: "prepared-2",
        }),
      ).toEqual(replied);
      expect(getConversationDeliveryOperation(scope, "operation-2")).toEqual(replied);
      // Late queue/sent callbacks cannot regress a completed correlated reply.
      expect(markConversationDeliveryQueued(scope, "operation-2", "queue-late")).toEqual(replied);
      expect(markConversationDeliverySent(scope, "operation-2", "platform-late")).toEqual(replied);
    });
  });

  it("does not revive an operation after an unqueued outcome became unknown", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-3",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      const unknown = markConversationDeliveryUnknown(scope, "operation-3");

      expect(unknown.status).toBe("unknown");
      expect(markConversationDeliveryQueued(scope, "operation-3", "queue-late")).toEqual(unknown);
      expect(markConversationDeliverySent(scope, "operation-3", "platform-late")).toEqual(unknown);
    });
  });

  it("persists a permanent rejection and never revives its delivery", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-rejected",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      markConversationDeliveryQueued(scope, "operation-rejected", "queue-rejected");

      const rejected = markConversationDeliveryRejected(
        scope,
        "operation-rejected",
        "atomic message limit",
      );

      expect(rejected).toMatchObject({
        status: "rejected",
        queueId: "queue-rejected",
        rejectionError: "atomic message limit",
      });
      expect(markConversationDeliverySent(scope, "operation-rejected", "platform-late")).toEqual(
        rejected,
      );
    });
  });

  it("preserves routed session bindings and terminal delivery evidence during maintenance", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const sessionKey = "agent:main:reef:direct:peer-agent";
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-preserved-session",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: sessionKey,
        message: "hello",
      });
      markConversationDeliverySent(scope, "operation-preserved-session", "platform-preserved");

      await applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: scope.storePath,
        maintenanceOverride: { mode: "enforce", pruneAfterMs: 1 },
      });

      expect(resolveConversation(scope, conversationRef)).toMatchObject({
        conversationRef,
        channel: "reef",
        sessionId: "reef-session",
      });
      expect(loadSessionEntry({ ...scope, sessionKey })?.archivedAt).toBeUndefined();
      expect(getConversationDeliveryOperation(scope, "operation-preserved-session")).toMatchObject({
        channel: "reef",
        conversationRef,
        platformMessageId: "platform-preserved",
        status: "sent",
      });
    });
  });

  it("removes only source-bound delivery evidence and its progress cache when fully deleted", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const sessionKey = "agent:main:reef:direct:peer-agent";
      const input = {
        conversationRef,
        sourceSessionKey: sessionKey,
        message: "hello",
        platformMessageId: "platform-deleted",
        progressSnapshot: { lines: ["Working"] },
        assertCurrent: () => {},
      };
      recordConversationProgressReceipt(scope, {
        ...input,
        operationId: "operation-deleted-session",
      });
      recordConversationProgressReceipt(scope, {
        ...input,
        operationId: "operation-other-session",
        sourceSessionKey: "agent:main:other",
      });
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
      database.db
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("unrelated", "operation-deleted-session", "keep", 1);

      await deleteSessionEntryLifecycle({
        agentId: scope.agentId,
        archiveTranscript: false,
        deleteDeliveryArtifacts: true,
        storePath: scope.storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });

      expect(getConversationDeliveryOperation(scope, "operation-deleted-session")).toBeUndefined();
      expect(getConversationProgressSnapshot(scope, "operation-deleted-session")).toBeUndefined();
      expect(getConversationProgressSnapshot(scope, "operation-other-session")).toEqual(
        input.progressSnapshot,
      );
      expect(
        database.db
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
          .get("unrelated", "operation-deleted-session"),
      ).toEqual({ value_json: "keep" });
      expect(resolveConversation(scope, conversationRef)).toMatchObject({ conversationRef });
    });
  });

  it("retains source-bound delivery evidence for guarded lifecycle cleanup", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const sessionKey = "agent:main:reef:direct:peer-agent";
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-migrated-session",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: sessionKey,
        message: "hello",
      });
      markConversationDeliverySent(scope, "operation-migrated-session", "platform-migrated");

      await deleteSessionEntryLifecycle({
        agentId: scope.agentId,
        archiveTranscript: false,
        storePath: scope.storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });

      expect(resolveConversation(scope, conversationRef)).toMatchObject({
        conversationRef,
        channel: "reef",
      });
      expect(resolveConversation(scope, conversationRef)?.sessionId).toBeUndefined();
      expect(loadSessionEntry({ ...scope, sessionKey })).toBeUndefined();
      expect(getConversationDeliveryOperation(scope, "operation-migrated-session")).toMatchObject({
        conversationRef,
        platformMessageId: "platform-migrated",
        sourceSessionKey: sessionKey,
        status: "sent",
      });
    });
  });

  it("makes a dead-lettered queued operation terminal", async () => {
    await withConversationStore(({ scope, conversationRef }) => {
      beginConversationDeliveryOperation(scope, {
        operationId: "operation-4",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      markConversationDeliveryQueued(scope, "operation-4", "queue-4");

      const unknown = markConversationDeliveryUnknown(scope, "operation-4");

      expect(unknown).toMatchObject({ status: "unknown", queueId: "queue-4" });
      expect(markConversationDeliverySent(scope, "operation-4", "platform-late")).toEqual(unknown);
    });
  });
});
