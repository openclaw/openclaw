import path from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  beginConversationDeliveryOperation,
  findConversationTurnDeliveryByReplyTarget,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
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

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-conversation-delivery-");

async function withConversationStore(
  run: (params: {
    scope: { agentId: string; storePath: string };
    conversationRef: string;
  }) => Promise<void> | void,
): Promise<void> {
  const dir = sessionDirs.make();
  const storePath = path.join(dir, "sessions.json");
  const scope = { agentId: "main", storePath };
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
}

describe("conversation delivery store", () => {
  it("reopens retained delivery receipts", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      await beginConversationDeliveryOperation(scope, {
        operationId: "legacy",
        operationKind: "send",
        conversationRef,
        message: "legacy",
      });
      const legacy = await markConversationDeliverySent(scope, "legacy", "legacy-message");
      await closeOpenClawAgentDatabasesAsync();
      expect(await getConversationDeliveryOperation(scope, "legacy")).toEqual(legacy);
    });
  });

  it("validates retry input without recreating a missing operation", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const input = {
        operationKind: "send" as const,
        conversationRef,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        message: "hello",
      };
      expect(await getConversationDeliveryOperation(scope, "missing", input)).toBeUndefined();
      expect(await getConversationDeliveryOperation(scope, "missing")).toBeUndefined();
      const begun = await beginConversationDeliveryOperation(scope, {
        operationId: "retry",
        ...input,
      });
      expect(
        await getConversationDeliveryOperation(scope, " retry ", {
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
        await expect(
          getConversationDeliveryOperation(scope, "retry", { ...input, ...changed }),
        ).rejects.toThrow("Conversation delivery operation was reused with different input: retry");
      }
      expect(await getConversationDeliveryOperation(scope, "retry")).toEqual(begun.record);
    });
  });

  it("creates idempotent operations and rejects operation-id input reuse", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
      const prepare = database.db.prepare.bind(database.db);
      const nativePrepare = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
        if (sql.includes("conversation_deliveries")) {
          throw new Error("delivery SQL ran on the caller thread");
        }
        return prepare(sql);
      });
      onTestFinished(() => nativePrepare.mockRestore());
      const first = await beginConversationDeliveryOperation(scope, {
        operationId: "operation-1",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        message: "hello",
        preparedMessageId: "prepared-1",
      });
      const repeated = await beginConversationDeliveryOperation(scope, {
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
      expect(await getConversationDeliveryOperation(scope, "operation-1")).toEqual(first.record);
      await markConversationDeliveryQueued(scope, "operation-1", "queue-1");
      await markConversationDeliverySent(scope, "operation-1", "sent-1");
      expect(
        await findConversationTurnDeliveryByReplyTarget(scope, {
          conversationRef,
          replyToId: "sent-1",
        }),
      ).toBeUndefined();
      nativePrepare.mockRestore();
      await expect(
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "send",
          conversationRef,
          message: "different",
        }),
      ).rejects.toThrow("reused with different input");
      await expect(
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "turn",
          conversationRef,
          sourceSessionKey: "agent:main:telegram:direct:operator",
          message: "hello",
        }),
      ).rejects.toThrow("reused with different input");
      await expect(
        beginConversationDeliveryOperation(scope, {
          operationId: "operation-1",
          operationKind: "send",
          conversationRef,
          sourceSessionKey: "agent:main:discord:channel:other",
          message: "hello",
        }),
      ).rejects.toThrow("reused with different input");
    });
  });

  it("persists queue, platform, and correlated reply evidence", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const begun = beginConversationDeliveryOperation(scope, {
        operationId: "operation-2",
        operationKind: "turn",
        conversationRef,
        message: "hello",
        preparedMessageId: "prepared-2",
      });
      const queued = markConversationDeliveryQueued(scope, "operation-2", "queue-2");
      const sent = markConversationDeliverySent(scope, "operation-2", "platform-2");
      const read = getConversationDeliveryOperation(scope, "operation-2");
      await begun;
      expect(await queued).toMatchObject({
        status: "queued",
        queueId: "queue-2",
      });
      expect(await sent).toMatchObject({
        status: "sent",
        platformMessageId: "platform-2",
      });
      expect(await read).toEqual(await sent);
      const replied = await markConversationDeliveryReplied(scope, {
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
        await findConversationTurnDeliveryByReplyTarget(scope, {
          conversationRef,
          replyToId: "prepared-2",
        }),
      ).toEqual(replied);
      expect(await getConversationDeliveryOperation(scope, "operation-2")).toEqual(replied);
      // Late queue/sent callbacks cannot regress a completed correlated reply.
      expect(await markConversationDeliveryQueued(scope, "operation-2", "queue-late")).toEqual(
        replied,
      );
      expect(await markConversationDeliverySent(scope, "operation-2", "platform-late")).toEqual(
        replied,
      );
    });
  });

  it("does not revive an operation after an unqueued outcome became unknown", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      await beginConversationDeliveryOperation(scope, {
        operationId: "operation-3",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      const unknown = await markConversationDeliveryUnknown(scope, "operation-3");

      expect(unknown.status).toBe("unknown");
      expect(await markConversationDeliveryQueued(scope, "operation-3", "queue-late")).toEqual(
        unknown,
      );
      expect(await markConversationDeliverySent(scope, "operation-3", "platform-late")).toEqual(
        unknown,
      );
    });
  });

  it("persists a permanent rejection and never revives its delivery", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      await beginConversationDeliveryOperation(scope, {
        operationId: "operation-rejected",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      await markConversationDeliveryQueued(scope, "operation-rejected", "queue-rejected");

      const rejected = await markConversationDeliveryRejected(
        scope,
        "operation-rejected",
        "atomic message limit",
      );

      expect(rejected).toMatchObject({
        status: "rejected",
        queueId: "queue-rejected",
        rejectionError: "atomic message limit",
      });
      expect(
        await markConversationDeliverySent(scope, "operation-rejected", "platform-late"),
      ).toEqual(rejected);
    });
  });

  it("preserves routed session bindings and terminal delivery evidence during maintenance", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const sessionKey = "agent:main:reef:direct:peer-agent";
      await beginConversationDeliveryOperation(scope, {
        operationId: "operation-preserved-session",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: sessionKey,
        message: "hello",
      });
      await markConversationDeliverySent(
        scope,
        "operation-preserved-session",
        "platform-preserved",
      );

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
      expect(
        await getConversationDeliveryOperation(scope, "operation-preserved-session"),
      ).toMatchObject({
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
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
      const progressJson = JSON.stringify({ lines: ["Working"] });
      for (const [operationId, sourceSessionKey] of [
        ["operation-deleted-session", sessionKey],
        ["operation-other-session", "agent:main:other"],
      ] as const) {
        await beginConversationDeliveryOperation(scope, {
          operationId,
          operationKind: "send",
          conversationRef,
          sourceSessionKey,
          message: "hello",
        });
        await markConversationDeliverySent(scope, operationId, "platform-deleted");
        database.db
          .prepare(
            "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('conversation-progress', ?, ?, 1)",
          )
          .run(operationId, progressJson);
      }
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

      expect(
        await getConversationDeliveryOperation(scope, "operation-deleted-session"),
      ).toBeUndefined();
      expect(
        database.db
          .prepare(
            "SELECT key, value_json FROM cache_entries WHERE scope = 'conversation-progress'",
          )
          .all(),
      ).toEqual([{ key: "operation-other-session", value_json: progressJson }]);
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
      await beginConversationDeliveryOperation(scope, {
        operationId: "operation-migrated-session",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: sessionKey,
        message: "hello",
      });
      await markConversationDeliverySent(scope, "operation-migrated-session", "platform-migrated");

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
      expect(
        await getConversationDeliveryOperation(scope, "operation-migrated-session"),
      ).toMatchObject({
        conversationRef,
        platformMessageId: "platform-migrated",
        sourceSessionKey: sessionKey,
        status: "sent",
      });
    });
  });

  it("makes a dead-lettered queued operation terminal", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      await beginConversationDeliveryOperation(scope, {
        operationId: "operation-4",
        operationKind: "send",
        conversationRef,
        message: "hello",
      });
      await markConversationDeliveryQueued(scope, "operation-4", "queue-4");

      const unknown = await markConversationDeliveryUnknown(scope, "operation-4");

      expect(unknown).toMatchObject({ status: "unknown", queueId: "queue-4" });
      expect(await markConversationDeliverySent(scope, "operation-4", "platform-late")).toEqual(
        unknown,
      );
    });
  });
  it("rejects a reservation whose caller loses authority while queued", async () => {
    await withConversationStore(async ({ scope, conversationRef }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const held = runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteReadScope(scope)),
        () => {
          entered.resolve();
          return release.promise;
        },
      );
      onTestFinished(async () => {
        release.resolve();
        await held;
      });
      await entered.promise;
      let current = true;
      const begun = beginConversationDeliveryOperation(
        scope,
        {
          operationId: "revoked",
          operationKind: "send",
          conversationRef,
          message: "hello",
        },
        () => {
          if (!current) {
            throw new Error("delivery authority revoked");
          }
        },
      );
      const rejected = expect(begun).rejects.toThrow("delivery authority revoked");
      current = false;
      release.resolve();
      await held;
      await rejected;
      expect(await getConversationDeliveryOperation(scope, "revoked")).toBeUndefined();
    });
  });
});
