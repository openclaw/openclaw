import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as transcriptRedact from "../../agents/transcript-redact.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliverySent,
} from "../../config/sessions/conversation-delivery-store.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { registerPendingConversationTurn } from "../../sessions/conversation-turns.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { capturePendingConversationTurnReply } from "./conversation-turn-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawAgentDatabasesForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function setupReefConversation(options: { agentId?: string; storePath?: string } = {}) {
  const stateDir = tempDirs.make("openclaw-conversation-capture-");
  const agentId = options.agentId ?? "main";
  const storePath = options.storePath ?? path.join(stateDir, "sessions.json");
  const sessionKey = `agent:${agentId}:reef:direct:peer-agent`;
  const sessionId = "reef-session";
  const cfg = { session: { store: storePath } } as OpenClawConfig;
  await sessionAccessor.upsertSessionEntryCore(
    { agentId, sessionKey, storePath },
    {
      sessionId,
      updatedAt: 100,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
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
    conversationRef: buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    }),
  };
}

function persistSentOperation(params: {
  scope: { agentId: string; storePath: string };
  operationId: string;
  conversationRef: string;
  outboundMessageId: string;
}) {
  beginConversationDeliveryOperation(params.scope, {
    operationId: params.operationId,
    operationKind: "turn",
    conversationRef: params.conversationRef,
    message: "outbound",
    preparedMessageId: params.outboundMessageId,
  });
  markConversationDeliveryQueued(params.scope, params.operationId, `queue-${params.operationId}`);
  markConversationDeliverySent(params.scope, params.operationId, params.outboundMessageId);
}

function inboundReply(
  setup: Awaited<ReturnType<typeof setupReefConversation>>,
  outboundMessageId: string,
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
    MessageSidFull: "inbound-admission",
    ReplyToIdFull: outboundMessageId,
    RawBody: "ordinary reply",
    BodyForAgent: "ordinary reply",
    commandText: "ordinary reply",
    agentText: "ordinary reply",
    rawText: "ordinary reply",
  } as FinalizedRuntimeMsgContext;
}

function registerCapture(setup: Awaited<ReturnType<typeof setupReefConversation>>, id: string) {
  persistSentOperation({ ...setup, operationId: id, outboundMessageId: id });
  const pending = registerPendingConversationTurn({
    agentId: setup.scope.agentId,
    id,
    conversationRef: setup.conversationRef,
    sessionId: setup.sessionId,
    timeoutMs: 50,
  });
  pending.setOutboundMessageId(id);
  return pending;
}

describe("conversation turn capture", () => {
  it.each(["complete", "cancel", "timeout", "replace", "lifecycle"] as const)(
    "retains reply ownership through writer admission: %s",
    async (outcome) => {
      const setup = await setupReefConversation();
      vi.useFakeTimers();
      const id = `admission-${outcome}`;
      const pending = registerCapture(setup, id);
      pending.markReady();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepared = createDeferredCore();
      const originalRedact = transcriptRedact.redactTranscriptMessage;
      vi.spyOn(transcriptRedact, "redactTranscriptMessage").mockImplementation((...args) => {
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
        capture = capturePendingConversationTurnReply({
          cfg: setup.cfg,
          ctx: inboundReply(setup, id),
        });
        await prepared.promise;
        expect(getConversationDeliveryOperation(setup.scope, id)?.status).toBe("sent");
        if (outcome === "cancel") {
          pending.cancel();
        }
        if (outcome === "timeout") {
          await vi.advanceTimersByTimeAsync(50);
        }
        if (outcome === "replace" || outcome === "lifecycle") {
          const scope = { ...setup.scope, sessionKey: setup.sessionKey };
          const entry = sessionAccessor.loadSessionEntryReadOnly(scope)!;
          sessionAccessor.replaceSessionEntrySync(scope, {
            ...entry,
            ...(outcome === "replace"
              ? { sessionId: "replacement" }
              : { lifecycleRevision: "replacement-lifecycle" }),
          });
        }
        release.resolve();
        await blocker;
        await expect(capture).resolves.toBe(outcome === "complete");
        const record = getConversationDeliveryOperation(setup.scope, id);
        expect(record?.status).toBe(outcome === "complete" ? "replied" : "sent");
        if (outcome === "complete") {
          await expect(pending.wait()).resolves.toMatchObject({ messageId: "inbound-admission" });
        } else {
          pending.cancel();
          await expect(pending.wait()).resolves.toBeUndefined();
          expect(record?.reply).toBeUndefined();
          expect(
            await sessionAccessor.loadTranscriptEvents({
              ...setup.scope,
              sessionId: setup.sessionId,
            }),
          ).toEqual([]);
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

  it.each(["replace", "lifecycle"] as const)(
    "rechecks the session after outbound correlation: %s",
    async (outcome) => {
      const setup = await setupReefConversation();
      vi.useFakeTimers();
      const id = `correlation-${outcome}`;
      const pending = registerCapture(setup, id);
      const capture = capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: inboundReply(setup, id),
      });
      try {
        const scope = { ...setup.scope, sessionKey: setup.sessionKey };
        const entry = sessionAccessor.loadSessionEntryReadOnly(scope)!;
        sessionAccessor.replaceSessionEntrySync(scope, {
          ...entry,
          ...(outcome === "replace"
            ? { sessionId: "replacement" }
            : { lifecycleRevision: "replacement-lifecycle" }),
        });
        pending.markReady();
        await expect(capture).resolves.toBe(false);
        expect(getConversationDeliveryOperation(setup.scope, id)?.reply).toBeUndefined();
      } finally {
        pending.cancel();
        await capture;
        vi.useRealTimers();
      }
    },
  );

  it("queues the no-waiter acknowledgement without making it replayable inline", async () => {
    const setup = await setupReefConversation();
    const id = "no-waiter-admission";
    beginConversationDeliveryOperation(setup.scope, {
      operationId: id,
      operationKind: "turn",
      conversationRef: setup.conversationRef,
      message: "outbound",
      preparedMessageId: id,
    });
    markConversationDeliveryQueued(setup.scope, id, `queue-${id}`);
    const release = createDeferredCore();
    const blocker = runOpenClawAgentWriteAdmission(
      toDatabaseOptions(resolveSqliteReadScope(setup.scope)),
      () => release.promise,
    );
    const capture = capturePendingConversationTurnReply({
      cfg: setup.cfg,
      ctx: inboundReply(setup, id),
    });
    try {
      await setImmediate();
      expect(getConversationDeliveryOperation(setup.scope, id)?.status).toBe("queued");
      release.resolve();
      await blocker;
      await expect(capture).resolves.toBe(false);
      expect(getConversationDeliveryOperation(setup.scope, id)).toMatchObject({ status: "sent" });
      expect(getConversationDeliveryOperation(setup.scope, id)?.reply).toBeUndefined();
      expect(
        await sessionAccessor.loadTranscriptEvents({ ...setup.scope, sessionId: setup.sessionId }),
      ).toEqual([]);
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
      const setup = await setupReefConversation();
      vi.useFakeTimers();
      const id = `state-${refused}`;
      const pending = registerCapture(setup, id);
      const capture = capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: inboundReply(setup, id),
      });
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
        const record = getConversationDeliveryOperation({ ...setup.scope, env: sourceEnv }, id);
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
    const setup = await setupReefConversation({ agentId: "logical-agent", storePath });
    vi.useFakeTimers();
    const id = "shared-store-capture";
    const pending = registerCapture(setup, id);
    pending.markReady();
    try {
      await expect(
        capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundReply(setup, id) }),
      ).resolves.toBe(true);
      await expect(pending.wait()).resolves.toMatchObject({ messageId: "inbound-admission" });
      expect(getConversationDeliveryOperation(setup.scope, id)?.status).toBe("replied");
      expect(physical.agentId).toBe("schema-owner");
      expect(
        await sessionAccessor.loadTranscriptEvents({ ...setup.scope, sessionId: setup.sessionId }),
      ).toHaveLength(1);
    } finally {
      pending.cancel();
      vi.useRealTimers();
    }
  });

  it("retains a relative configured store when the working directory changes during correlation", async () => {
    const setup = await setupReefConversation();
    const cfg = {
      session: { store: path.relative(process.cwd(), setup.storePath) },
    } as OpenClawConfig;
    const movedDirectory = tempDirs.make("capture-moved-cwd-");
    vi.useFakeTimers();
    const id = "relative-store-capture";
    const pending = registerCapture(setup, id);
    const capture = capturePendingConversationTurnReply({ cfg, ctx: inboundReply(setup, id) });
    try {
      vi.spyOn(process, "cwd").mockReturnValue(movedDirectory);
      pending.markReady();
      await expect(capture).resolves.toBe(true);
      await expect(pending.wait()).resolves.toMatchObject({ messageId: "inbound-admission" });
      expect(getConversationDeliveryOperation(setup.scope, id)?.status).toBe("replied");
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
    const setup = await setupReefConversation({ agentId: "logical-agent", storePath });
    vi.useFakeTimers();
    const id = "replaced-owner-capture";
    const pending = registerCapture(setup, id);
    const capture = capturePendingConversationTurnReply({
      cfg: setup.cfg,
      ctx: inboundReply(setup, id),
    });
    try {
      closeOpenClawAgentDatabasesForTest();
      fs.renameSync(storePath, `${storePath}.retired`);
      unregisterOpenClawAgentDatabase({ agentId: "original-owner", path: storePath });
      openOpenClawAgentDatabase({ agentId: "replacement-owner", path: storePath });
      const replacement = await setupReefConversation({ agentId: "logical-agent", storePath });
      persistSentOperation({ ...replacement, operationId: id, outboundMessageId: id });
      pending.markReady();
      await expect(capture).resolves.toBe(false);
      expect(getConversationDeliveryOperation(replacement.scope, id)?.status).toBe("sent");
      expect(
        await sessionAccessor.loadTranscriptEvents({
          ...replacement.scope,
          sessionId: replacement.sessionId,
        }),
      ).toEqual([]);
    } finally {
      pending.cancel();
      await capture;
      vi.useRealTimers();
    }
  });

  it("fails closed without channel ingress admission proof", async () => {
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "turn-untrusted",
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-untrusted");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: {} as OpenClawConfig,
        ctx: {
          SessionKey: "agent:main:reef:direct:untrusted",
          ChatType: "direct",
          Provider: "reef",
          ReplyToIdFull: "outbound-untrusted",
          RawBody: "untrusted reply",
          commandText: "untrusted reply",
          agentText: "untrusted reply",
          rawText: "untrusted reply",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);
    pending.cancel();
  });

  it("consumes a correlated reply inline and persists only a side artifact", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-full-id";
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId: "reef-outbound-full",
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("reef-outbound-full");
    pending.markReady();

    const inboundContext = {
      AgentId: "main",
      SessionKey: setup.sessionKey,
      ChatType: "direct",
      Provider: "reef",
      InboundAccessAuthorized: true,
      OriginatingChannel: "reef",
      OriginatingTo: "reef:peer-agent",
      NativeDirectUserId: "peer-agent",
      MessageSid: "reef-inbound-short",
      MessageSidFull: "reef-inbound-full",
      ReplyToId: "wrong-short-id",
      ReplyToIdFull: "reef-outbound-full",
      RawBody: "peer acknowledged",
      BodyForAgent: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      commandText: "peer acknowledged",
      agentText: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      rawText: "peer acknowledged",
      Timestamp: 1_710_000_000,
    } as FinalizedRuntimeMsgContext;
    await expect(
      capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
    ).resolves.toBe(true);

    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef: setup.conversationRef,
      messageId: "reef-inbound-full",
      replyToId: "reef-outbound-full",
      text: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      timestamp: 1_710_000_000_000,
      transcriptArtifactId: `conversation-turn-reply-${operationId}`,
    });
    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      status: "replied",
      reply: {
        messageId: "reef-inbound-full",
        replyToId: "reef-outbound-full",
        text: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      },
    });
    const events = await sessionAccessor.loadTranscriptEvents({
      agentId: "main",
      sessionId: setup.sessionId,
      storePath: setup.storePath,
    });
    expect(events.filter((event) => "message" in (event as Record<string, unknown>))).toEqual([]);
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
    expect(
      await sessionAccessor.loadTranscriptEvents({
        agentId: "main",
        sessionId: setup.sessionId,
        storePath: setup.storePath,
      }),
    ).toHaveLength(1);
  });

  it("redacts the durable reply and its audit artifact before persistence", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-redacted";
    const outboundMessageId = "reef-outbound-redacted";
    const redactedValue = "sensitive-reply-value";
    const replyText = `trusted provenance\n\n<reef-message>secret ${redactedValue}</reef-message>`;
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId,
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId(outboundMessageId);
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: {
          ...setup.cfg,
          logging: {
            redactPatterns: ["sensitive-reply-[a-z]+"],
          },
        },
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-redacted",
          ReplyToIdFull: outboundMessageId,
          RawBody: `secret ${redactedValue}`,
          BodyForAgent: replyText,
          commandText: `secret ${redactedValue}`,
          agentText: replyText,
          rawText: `secret ${redactedValue}`,
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({ text: replyText });

    const operation = getConversationDeliveryOperation(setup.scope, operationId);
    expect(operation?.reply?.text).toBeTruthy();
    expect(operation?.reply?.text).not.toContain(redactedValue);
    const events = await sessionAccessor.loadTranscriptEvents({
      agentId: "main",
      sessionId: setup.sessionId,
      storePath: setup.storePath,
    });
    expect(JSON.stringify(events)).not.toContain(redactedValue);
  });

  it("completes the durable reply when optional audit persistence throws", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-audit-failure";
    const outboundMessageId = "reef-outbound-audit-failure";
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId,
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId(outboundMessageId);
    pending.markReady();
    vi.spyOn(sessionAccessor, "appendTranscriptEventSync").mockImplementationOnce(() => {
      throw new Error("audit store unavailable");
    });

    await expect(
      capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-audit-failure",
          ReplyToIdFull: outboundMessageId,
          RawBody: "reply survives audit failure",
          BodyForAgent: "reply survives audit failure",
          commandText: "reply survives audit failure",
          agentText: "reply survives audit failure",
          rawText: "reply survives audit failure",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toEqual(
      expect.objectContaining({ text: "reply survives audit failure" }),
    );
    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      status: "replied",
      reply: { text: "reply survives audit failure" },
    });
  });

  it("does not make an ordinary post-restart reply replayable inline", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-after-restart";
    beginConversationDeliveryOperation(setup.scope, {
      operationId,
      operationKind: "turn",
      conversationRef: setup.conversationRef,
      message: "outbound",
      preparedMessageId: "reef-outbound-restart",
    });
    markConversationDeliveryQueued(setup.scope, operationId, `queue-${operationId}`);

    await expect(
      capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-restart",
          ReplyToIdFull: "reef-outbound-restart",
          RawBody: "reply after restart",
          BodyForAgent: "reply after restart",
          commandText: "reply after restart",
          agentText: "reply after restart",
          rawText: "reply after restart",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);

    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      status: "sent",
      platformMessageId: "reef-outbound-restart",
    });
    expect(getConversationDeliveryOperation(setup.scope, operationId)?.reply).toBeUndefined();
    expect(
      await sessionAccessor.loadTranscriptEvents({
        agentId: "main",
        sessionId: setup.sessionId,
        storePath: setup.storePath,
      }),
    ).toEqual([]);
  });

  it("leaves replies to plain sends for ordinary inbound dispatch", async () => {
    const setup = await setupReefConversation();
    const operationId = "send-before-reply";
    beginConversationDeliveryOperation(setup.scope, {
      operationId,
      operationKind: "send",
      conversationRef: setup.conversationRef,
      message: "one-way outbound",
      preparedMessageId: "reef-outbound-send",
    });
    markConversationDeliveryQueued(setup.scope, operationId, `queue-${operationId}`);

    await expect(
      capturePendingConversationTurnReply({
        cfg: setup.cfg,
        ctx: {
          AgentId: "main",
          SessionKey: setup.sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-send-reply",
          ReplyToIdFull: "reef-outbound-send",
          RawBody: "ordinary reply",
          BodyForAgent: "ordinary reply",
          commandText: "ordinary reply",
          agentText: "ordinary reply",
          rawText: "ordinary reply",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);
    expect(getConversationDeliveryOperation(setup.scope, operationId)).toMatchObject({
      operationKind: "send",
      status: "queued",
    });
  });

  it("consumes duplicate replies that promoted an unthreaded message into a thread", async () => {
    const setup = await setupReefConversation();
    const operationId = "turn-promoted-thread";
    const outboundMessageId = "reef-promoted-root";
    persistSentOperation({
      scope: setup.scope,
      operationId,
      conversationRef: setup.conversationRef,
      outboundMessageId,
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: operationId,
      conversationRef: setup.conversationRef,
      sessionId: setup.sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId(outboundMessageId);
    pending.markReady();
    const inboundContext = {
      AgentId: "main",
      SessionKey: setup.sessionKey,
      ChatType: "direct",
      Provider: "reef",
      InboundAccessAuthorized: true,
      OriginatingChannel: "reef",
      OriginatingTo: "reef:peer-agent",
      NativeDirectUserId: "peer-agent",
      MessageThreadId: outboundMessageId,
      MessageSidFull: "reef-promoted-reply",
      ReplyToIdFull: outboundMessageId,
      RawBody: "thread-promoted reply",
      BodyForAgent: "thread-promoted reply",
      commandText: "thread-promoted reply",
      agentText: "thread-promoted reply",
      rawText: "thread-promoted reply",
    } as FinalizedRuntimeMsgContext;

    await expect(
      capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({
      messageId: "reef-promoted-reply",
      replyToId: outboundMessageId,
      threadId: outboundMessageId,
    });
    await expect(
      capturePendingConversationTurnReply({ cfg: setup.cfg, ctx: inboundContext }),
    ).resolves.toBe(true);
  });

  it("captures a threaded reply only for the exact conversation and message", async () => {
    const stateDir = tempDirs.make("openclaw-conversation-capture-");
    const storePath = path.join(stateDir, "sessions.json");
    const scope = { agentId: "main", storePath };
    const sessionKey = "agent:main:discord:channel:ops-room:thread:user-context";
    const sessionId = "discord-thread-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await sessionAccessor.upsertSessionEntryCore(
      { ...scope, sessionKey },
      {
        sessionId,
        updatedAt: 100,
        chatType: "channel",
        groupId: "ops-room",
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "discord",
            accountId: "default",
            to: "channel:ops-room",
            threadId: "user-context",
          },
          origin: { provider: "discord", accountId: "default", nativeChannelId: "ops-room" },
        }),
      },
    );
    const conversationRef = buildConversationRef({
      channel: "discord",
      accountId: "default",
      kind: "channel",
      peerId: "ops-room",
      threadId: "user-context",
    });
    persistSentOperation({
      scope,
      operationId: "turn-thread",
      conversationRef,
      outboundMessageId: "discord-outbound-full",
    });
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "turn-thread",
      conversationRef,
      sessionId,
      threadId: "user-context",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("discord-outbound-full");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg,
        ctx: {
          AgentId: "main",
          SessionKey: sessionKey,
          ChatType: "channel",
          Provider: "discord",
          InboundAccessAuthorized: true,
          From: "discord:channel:ops-room",
          To: "channel:ops-room",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:ops-room",
          NativeChannelId: "ops-room",
          MessageThreadId: "user-context",
          MessageSidFull: "discord-inbound-full",
          ReplyToIdFull: "discord-outbound-full",
          SenderId: "member-1",
          RawBody: "channel ack",
          BodyForAgent: "channel ack",
          commandText: "channel ack",
          agentText: "channel ack",
          rawText: "channel ack",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef,
      threadId: "user-context",
      text: "channel ack",
    });
  });

  it("falls through without claiming when the inbound session cannot be resolved", async () => {
    const stateDir = tempDirs.make("openclaw-conversation-capture-");
    const pending = registerPendingConversationTurn({
      agentId: "main",
      id: "turn-missing",
      conversationRef: buildConversationRef({
        channel: "reef",
        accountId: "default",
        kind: "direct",
        peerId: "missing",
      }),
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-missing");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: { session: { store: path.join(stateDir, "sessions.json") } } as OpenClawConfig,
        ctx: {
          SessionKey: "agent:main:reef:direct:missing",
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:missing",
          NativeDirectUserId: "missing",
          MessageSidFull: "inbound-missing",
          ReplyToIdFull: "outbound-missing",
          RawBody: "fall through",
          BodyForAgent: "fall through",
          commandText: "fall through",
          agentText: "fall through",
          rawText: "fall through",
        } as FinalizedRuntimeMsgContext,
      }),
    ).resolves.toBe(false);
    pending.cancel();
  });
});
