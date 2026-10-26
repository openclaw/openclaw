import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as transcriptRedact from "../../agents/transcript-sanitize.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliverySent,
} from "../../config/sessions/conversation-delivery-store.js";
import * as conversationDeliveryStore from "../../config/sessions/conversation-delivery-store.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readConversationDeliveryStateForTest } from "../../gateway/conversation-delivery.test-support.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { registerPendingConversationTurn } from "../../sessions/conversation-turns.js";
import * as conversationTurns from "../../sessions/conversation-turns.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { capturePendingConversationTurnReply } from "./conversation-turn-capture.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});

async function setupConversation(
  options: { agentId?: string; storePath?: string; threadId?: string } = {},
) {
  const stateDir = tempDirs.make("openclaw-conversation-capture-");
  const agentId = options.agentId ?? "main";
  const storePath = options.storePath ?? path.join(stateDir, "sessions.json");
  const { threadId } = options;
  const channel = threadId ? "discord" : "reef";
  const kind = threadId ? "channel" : "direct";
  const peerId = threadId ? "ops-room" : "peer-agent";
  const to = threadId ? "channel:ops-room" : "reef:peer-agent";
  const sessionKey = `agent:${agentId}:${channel}:${kind}:${peerId}${threadId ? `:thread:${threadId}` : ""}`;
  const sessionId = "reef-session";
  const cfg = { session: { store: storePath } } as OpenClawConfig;
  await sessionAccessor.upsertSessionEntryCore(
    { agentId, sessionKey, storePath },
    {
      sessionId,
      updatedAt: 100,
      chatType: kind,
      ...(threadId ? { groupId: peerId } : {}),
      delivery: normalizeSessionDeliveryState({
        context: { channel, accountId: "default", to, threadId },
        origin: {
          provider: channel,
          accountId: "default",
          ...(threadId ? { nativeChannelId: peerId } : { nativeDirectUserId: peerId }),
        },
      }),
    },
  );
  return {
    cfg,
    scope: { agentId, storePath },
    sessionKey,
    sessionId,
    storePath,
    context: {
      ChatType: kind,
      Provider: channel,
      OriginatingChannel: channel,
      OriginatingTo: to,
      ...(threadId
        ? {
            From: "discord:channel:ops-room",
            To: to,
            NativeChannelId: peerId,
            NativeDirectUserId: undefined,
            MessageThreadId: threadId,
            SenderId: "member-1",
          }
        : { NativeDirectUserId: peerId }),
    },
    conversationRef: buildConversationRef({
      channel,
      accountId: "default",
      kind,
      peerId,
      threadId,
    }),
  };
}

async function persistSentOperation(params: {
  scope: { agentId: string; storePath: string };
  operationId: string;
  conversationRef: string;
  outboundMessageId: string;
}) {
  await beginConversationDeliveryOperation(params.scope, {
    operationId: params.operationId,
    operationKind: "turn",
    conversationRef: params.conversationRef,
    message: "outbound",
    preparedMessageId: params.outboundMessageId,
  });
  await markConversationDeliveryQueued(
    params.scope,
    params.operationId,
    `queue-${params.operationId}`,
  );
  await markConversationDeliverySent(params.scope, params.operationId, params.outboundMessageId);
}

function inboundReply(
  setup: {
    scope: { agentId: string };
    sessionKey: string;
    context?: Partial<FinalizedRuntimeMsgContext>;
  },
  outboundMessageId: string,
  overrides: Partial<FinalizedRuntimeMsgContext> = {},
  text = "ordinary reply",
) {
  return {
    AgentId: setup.scope.agentId,
    SessionKey: setup.sessionKey,
    ChatType: "direct",
    Provider: "reef",
    InboundAccessAuthorized: true,
    OriginatingChannel: "reef",
    OriginatingTo: "reef:peer-agent",
    NativeDirectUserId: "peer-agent",
    ...setup.context,
    MessageSidFull: "inbound-admission",
    ReplyToIdFull: outboundMessageId,
    RawBody: text,
    BodyForAgent: text,
    commandText: text,
    agentText: text,
    rawText: text,
    ...overrides,
  } as FinalizedRuntimeMsgContext;
}

async function registerCapture(
  setup: Pick<Conversation, "scope" | "conversationRef" | "sessionId">,
  id: string,
  {
    outboundMessageId = id,
    timeoutMs = 50,
    threadId,
  }: {
    outboundMessageId?: string;
    timeoutMs?: number;
    threadId?: string;
  } = {},
) {
  await persistSentOperation({ ...setup, operationId: id, outboundMessageId });
  const pending = registerPendingConversationTurn({
    agentId: setup.scope.agentId,
    id,
    conversationRef: setup.conversationRef,
    sessionId: setup.sessionId,
    threadId,
    timeoutMs,
  });
  pending.setOutboundMessageId(outboundMessageId);
  return pending;
}

type Conversation = Awaited<ReturnType<typeof setupConversation>>;
const transcriptEvents = (setup: Conversation) =>
  sessionAccessor.loadTranscriptEvents({ ...setup.scope, sessionId: setup.sessionId });
const captureReply = (
  setup: Conversation,
  id: string,
  overrides: Partial<FinalizedRuntimeMsgContext> = {},
  text?: string,
) =>
  capturePendingConversationTurnReply({
    cfg: setup.cfg,
    ctx: inboundReply(setup, id, overrides, text),
  });

function replaceIdentity(setup: Conversation, outcome: "replace" | "lifecycle" | "writer") {
  const scope = { ...setup.scope, sessionKey: setup.sessionKey };
  sessionAccessor.replaceSessionEntrySync(scope, {
    ...sessionAccessor.loadSessionEntryReadOnly(scope)!,
    ...(outcome === "replace"
      ? { sessionId: "replacement" }
      : outcome === "lifecycle"
        ? { lifecycleRevision: "replacement-lifecycle" }
        : { activeWriterRunId: "replacement-writer" }),
  });
}

describe("conversation turn capture", () => {
  it.each(["complete", "cancel", "timeout", "replace", "lifecycle"] as const)(
    "retains reply ownership through writer admission: %s",
    async (outcome) => {
      const setup = await setupConversation();
      vi.useFakeTimers();
      const id = `admission-${outcome}`;
      const pending = await registerCapture(setup, id);
      pending.markReady();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepared = createDeferredCore();
      const originalRedact = transcriptRedact.sanitizeTranscriptMessage;
      vi.spyOn(transcriptRedact, "sanitizeTranscriptMessage").mockImplementation((...args) => {
        const message = originalRedact(...args);
        prepared.resolve();
        return message;
      });
      const blocker = runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteReadScope(setup.scope)),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      let capture: Promise<boolean> | undefined;
      try {
        capture = captureReply(setup, id);
        await prepared.promise;
        expect(readConversationDeliveryStateForTest(setup.scope, id)?.status).toBe("sent");
        if (outcome === "cancel") {
          pending.cancel();
        }
        if (outcome === "timeout") {
          await vi.advanceTimersByTimeAsync(50);
        }
        if (outcome === "replace" || outcome === "lifecycle") {
          replaceIdentity(setup, outcome);
        }
        release.resolve();
        await blocker;
        await expect(capture).resolves.toBe(outcome === "complete");
        const record = await getConversationDeliveryOperation(setup.scope, id);
        expect(record?.status).toBe(outcome === "complete" ? "replied" : "sent");
        if (outcome === "complete") {
          await expect(pending.wait()).resolves.toMatchObject({ messageId: "inbound-admission" });
        } else {
          pending.cancel();
          await expect(pending.wait()).resolves.toBeUndefined();
          expect(record?.reply).toBeUndefined();
          expect(await transcriptEvents(setup)).toEqual([]);
        }
      } finally {
        pending.cancel();
        release.resolve();
        await blocker;
        await capture;
        vi.useRealTimers();
      }
    },
  );

  it.each(["timeout", "replace", "lifecycle", "writer"] as const)(
    "consumes a committed reply when its audit authority changes: %s",
    async (outcome) => {
      const setup = await setupConversation();
      vi.useFakeTimers();
      const id = "reply-committed-before-expiry";
      const pending = await registerCapture(setup, id);
      pending.markReady();
      const markReplied = conversationDeliveryStore.markConversationDeliveryReplied;
      vi.spyOn(conversationDeliveryStore, "markConversationDeliveryReplied").mockImplementationOnce(
        async (...args) => {
          const committed = await markReplied(...args);
          if (outcome === "timeout") {
            await vi.advanceTimersByTimeAsync(50);
          } else {
            replaceIdentity(setup, outcome);
          }
          return committed;
        },
      );
      try {
        await expect(captureReply(setup, id)).resolves.toBe(true);
        if (outcome === "timeout") {
          await expect(pending.wait()).resolves.toBeUndefined();
        } else {
          const reply = await pending.wait();
          expect(reply?.messageId).toBe("inbound-admission");
          expect(reply?.transcriptArtifactId).toBeUndefined();
        }
        expect(await getConversationDeliveryOperation(setup.scope, id)).toMatchObject({
          status: "replied",
          reply: { messageId: "inbound-admission", text: "ordinary reply", replyToId: id },
        });
        expect(await transcriptEvents(setup)).toEqual([]);
      } finally {
        pending.cancel();
        vi.useRealTimers();
      }
    },
  );

  it.each(["replace", "lifecycle"] as const)(
    "rechecks the session after outbound correlation: %s",
    async (outcome) => {
      const setup = await setupConversation();
      vi.useFakeTimers();
      const id = `correlation-${outcome}`;
      const pending = await registerCapture(setup, id);
      const correlating = createDeferredCore();
      const claimReply = conversationTurns.claimPendingConversationTurnReply;
      vi.spyOn(conversationTurns, "claimPendingConversationTurnReply").mockImplementationOnce(
        (...args) => {
          correlating.resolve();
          return claimReply(...args);
        },
      );
      const capture = captureReply(setup, id);
      try {
        await correlating.promise;
        replaceIdentity(setup, outcome);
        pending.markReady();
        await expect(capture).resolves.toBe(false);
        expect((await getConversationDeliveryOperation(setup.scope, id))?.reply).toBeUndefined();
      } finally {
        pending.cancel();
        await capture;
        vi.useRealTimers();
      }
    },
  );

  it("queues the no-waiter acknowledgement without making it replayable inline", async () => {
    const setup = await setupConversation();
    const id = "no-waiter-admission";
    await beginConversationDeliveryOperation(setup.scope, {
      operationId: id,
      operationKind: "turn",
      conversationRef: setup.conversationRef,
      message: "outbound",
      preparedMessageId: id,
    });
    await markConversationDeliveryQueued(setup.scope, id, `queue-${id}`);
    const release = createDeferredCore();
    const blocker = runOpenClawAgentWriteAdmission(
      toDatabaseOptions(resolveSqliteReadScope(setup.scope)),
      () => release.promise,
    );
    const capture = captureReply(setup, id);
    try {
      await setImmediate();
      expect(readConversationDeliveryStateForTest(setup.scope, id)?.status).toBe("queued");
      release.resolve();
      await blocker;
      await expect(capture).resolves.toBe(false);
      expect(await getConversationDeliveryOperation(setup.scope, id)).toMatchObject({
        status: "sent",
        platformMessageId: id,
      });
      expect((await getConversationDeliveryOperation(setup.scope, id))?.reply).toBeUndefined();
      expect(await transcriptEvents(setup)).toEqual([]);
    } finally {
      release.resolve();
      await blocker;
      await capture;
    }
  });

  it.each(["source", "ambient"] as const)(
    "retains the source state authority when %s is refused during correlation",
    async (refused) => {
      const sourceEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("capture-source-state-"),
      };
      const ambientEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("capture-other-state-"),
      };
      vi.stubEnv("OPENCLAW_STATE_DIR", sourceEnv.OPENCLAW_STATE_DIR);
      const setup = await setupConversation();
      vi.useFakeTimers();
      const id = `state-${refused}`;
      const pending = await registerCapture(setup, id);
      const capture = captureReply(setup, id);
      const refusalEnv = refused === "source" ? sourceEnv : ambientEnv;
      try {
        recordAgentDatabaseAdmissions(
          [
            {
              agentId: "main",
              paths: [setup.storePath],
              embeddedOwnerId: "other",
              code: "agent-database-ownership-mismatch",
              reason: "fixture owner retired",
              repairHint: "fixture",
            },
          ],
          { env: refusalEnv },
        );
        vi.stubEnv("OPENCLAW_STATE_DIR", ambientEnv.OPENCLAW_STATE_DIR);
        pending.markReady();
        await expect(capture).resolves.toBe(refused !== "source");
        recordAgentDatabaseAdmissions([], { env: refusalEnv });
        const record = await getConversationDeliveryOperation(
          { ...setup.scope, env: sourceEnv },
          id,
        );
        expect(record?.status).toBe(refused === "source" ? "sent" : "replied");
      } finally {
        recordAgentDatabaseAdmissions([], { env: refusalEnv });
        pending.cancel();
        await capture;
        vi.useRealTimers();
      }
    },
  );

  it("keeps the logical agent on a shared physical store across admission", async () => {
    const storePath = path.join(tempDirs.make("capture-shared-store-"), "shared.sqlite");
    const physical = openOpenClawAgentDatabase({ agentId: "schema-owner", path: storePath });
    const setup = await setupConversation({ agentId: "logical-agent", storePath });
    vi.useFakeTimers();
    const id = "shared-store-capture";
    const pending = await registerCapture(setup, id);
    pending.markReady();
    try {
      await expect(captureReply(setup, id)).resolves.toBe(true);
      await expect(pending.wait()).resolves.toMatchObject({ messageId: "inbound-admission" });
      expect((await getConversationDeliveryOperation(setup.scope, id))?.status).toBe("replied");
      expect(physical.agentId).toBe("schema-owner");
      expect(await transcriptEvents(setup)).toHaveLength(1);
    } finally {
      pending.cancel();
      vi.useRealTimers();
    }
  });

  it("retains a relative configured store when the working directory changes during correlation", async () => {
    const setup = await setupConversation();
    const cfg = {
      session: { store: path.relative(resolveStateDir(), setup.storePath) },
    } as OpenClawConfig;
    const movedDirectory = tempDirs.make("capture-moved-cwd-");
    vi.useFakeTimers();
    const id = "relative-store-capture";
    const pending = await registerCapture(setup, id);
    const capture = capturePendingConversationTurnReply({ cfg, ctx: inboundReply(setup, id) });
    try {
      vi.spyOn(process, "cwd").mockReturnValue(movedDirectory);
      pending.markReady();
      await expect(capture).resolves.toBe(true);
      await expect(pending.wait()).resolves.toMatchObject({ messageId: "inbound-admission" });
      expect((await getConversationDeliveryOperation(setup.scope, id))?.status).toBe("replied");
    } finally {
      vi.restoreAllMocks();
      pending.cancel();
      await capture;
      vi.useRealTimers();
    }
  });

  it("does not capture into a replacement shared-store owner with matching logical identities", async () => {
    const storePath = path.join(tempDirs.make("capture-replaced-store-"), "shared.sqlite");
    openOpenClawAgentDatabase({ agentId: "original-owner", path: storePath });
    const setup = await setupConversation({ agentId: "logical-agent", storePath });
    vi.useFakeTimers();
    const id = "replaced-owner-capture";
    const pending = await registerCapture(setup, id);
    const capture = captureReply(setup, id);
    try {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      fs.renameSync(storePath, `${storePath}.retired`);
      unregisterOpenClawAgentDatabase({ agentId: "original-owner", path: storePath });
      openOpenClawAgentDatabase({ agentId: "replacement-owner", path: storePath });
      const replacement = await setupConversation({ agentId: "logical-agent", storePath });
      await persistSentOperation({ ...replacement, operationId: id, outboundMessageId: id });
      pending.markReady();
      await expect(capture).resolves.toBe(false);
      expect((await getConversationDeliveryOperation(replacement.scope, id))?.status).toBe("sent");
      expect(await transcriptEvents(replacement)).toEqual([]);
    } finally {
      pending.cancel();
      await capture;
      vi.useRealTimers();
    }
  });

  it.each(["direct", "promoted", "threaded", "audit-failure"] as const)(
    "captures a %s reply once without applying log redaction to durable text",
    async (mode) => {
      const threadId =
        mode === "threaded"
          ? "user-context"
          : mode === "promoted"
            ? "reef-outbound-full"
            : undefined;
      const setup = await setupConversation(mode === "threaded" ? { threadId } : {});
      setup.cfg.logging = { redactPatterns: ["peer acknowledged"] };
      if (mode === "audit-failure") {
        openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(setup.scope))).db.exec(`
          CREATE TRIGGER refuse_reply_audit BEFORE INSERT ON transcript_events
          WHEN json_extract(NEW.event_json, '$.customType') = 'openclaw.conversation-turn-reply'
          BEGIN SELECT RAISE(ABORT, 'audit store unavailable'); END;
        `);
      }
      const operationId = "turn-full-id";
      const pending = await registerCapture(setup, operationId, {
        outboundMessageId: "reef-outbound-full",
        timeoutMs: 5_000,
        threadId: mode === "threaded" ? threadId : undefined,
      });
      pending.markReady();

      const inboundContext = inboundReply(setup, "reef-outbound-full", {
        MessageSid: "reef-inbound-short",
        MessageSidFull: "reef-inbound-full",
        ReplyToId: "wrong-short-id",
        RawBody: "peer acknowledged",
        BodyForAgent: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
        commandText: "peer acknowledged",
        agentText: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
        rawText: "peer acknowledged",
        Timestamp: 1_710_000_000,
        MessageThreadId: threadId,
      });
      const sql = observeHostDataSql();
      try {
        await expect(
          capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
        ).resolves.toBe(true);
      } finally {
        sql.restore();
      }
      expect(
        sql.queries.filter((query) => /insert\s+into\s+"?transcript_events"?/iu.test(query)),
      ).toEqual([]);

      const reply = await pending.wait();
      expect(reply).toMatchObject({
        conversationRef: setup.conversationRef,
        messageId: "reef-inbound-full",
        replyToId: "reef-outbound-full",
        text: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
        timestamp: 1_710_000_000_000,
        ...(threadId ? { threadId } : {}),
      });
      if (mode === "audit-failure") {
        expect(reply).not.toHaveProperty("transcriptArtifactId");
      } else {
        expect(reply?.transcriptArtifactId).toBe(`conversation-turn-reply-${operationId}`);
      }
      expect(await getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
        status: "replied",
        reply: {
          messageId: "reef-inbound-full",
          replyToId: "reef-outbound-full",
          text: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
        },
      });
      const events = await transcriptEvents(setup);
      expect(events.filter((event) => "message" in (event as Record<string, unknown>))).toEqual([]);
      if (mode === "audit-failure") {
        expect(events).toEqual([]);
      } else {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "custom",
            customType: "openclaw.conversation-turn-reply",
            appendMode: "side",
            data: expect.objectContaining({
              turnId: operationId,
              conversationRef: setup.conversationRef,
              messageId: "reef-inbound-full",
              message: expect.objectContaining({
                role: "user",
                content: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
              }),
            }),
          }),
        );
      }
      await expect(
        capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
      ).resolves.toBe(true);
      await expect(
        capturePendingConversationTurnReply({
          cfg: setup.cfg,
          ctx: {
            ...inboundContext,
            MessageSidFull: "reef-inbound-distinct",
            RawBody: "new ordinary message",
            BodyForAgent: "new ordinary message",
            commandText: "new ordinary message",
            agentText: "new ordinary message",
            rawText: "new ordinary message",
          } as FinalizedRuntimeMsgContext,
        }),
      ).resolves.toBe(false);
      expect(await transcriptEvents(setup)).toHaveLength(mode === "audit-failure" ? 0 : 1);
    },
  );

  it("leaves replies to plain sends for ordinary inbound dispatch", async () => {
    const setup = await setupConversation();
    const operationId = "send-before-reply";
    await beginConversationDeliveryOperation(setup.scope, {
      operationId,
      operationKind: "send",
      conversationRef: setup.conversationRef,
      message: "one-way outbound",
      preparedMessageId: "reef-outbound-send",
    });
    await markConversationDeliveryQueued(setup.scope, operationId, `queue-${operationId}`);

    await expect(
      captureReply(setup, "reef-outbound-send", {
        MessageSidFull: "reef-inbound-send-reply",
      }),
    ).resolves.toBe(false);
    expect(await getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      operationKind: "send",
      status: "queued",
    });
  });

  it.each([undefined, true])(
    "falls through without ingress proof or a session (authorized: %s)",
    async (authorized) => {
      const setup = await setupConversation();
      const pending = await registerCapture(setup, "unclaimed", { timeoutMs: 5_000 });
      pending.markReady();
      await expect(
        captureReply(setup, "unclaimed", {
          InboundAccessAuthorized: authorized,
          ...(authorized ? { SessionKey: "agent:main:reef:direct:missing" } : {}),
        }),
      ).resolves.toBe(false);
      pending.cancel();
    },
  );
});
