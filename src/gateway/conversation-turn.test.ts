import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
} from "../config/sessions/conversation-delivery-store.js";
import * as deliveryStore from "../config/sessions/conversation-delivery-store.js";
import {
  prepareConversationRegistryScope,
  registerConversationAddresses,
} from "../config/sessions/conversation-registry.js";
import * as conversationRegistry from "../config/sessions/conversation-registry.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as channelResolution from "../infra/outbound/channel-resolution.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import * as messageActionRunner from "../infra/outbound/message-action-runner.js";
import * as outboundSession from "../infra/outbound/outbound-session.js";
import { claimPendingConversationTurnReply } from "../sessions/conversation-turns.js";
import * as conversationTurns from "../sessions/conversation-turns.js";
import * as agentDatabase from "../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  conversation,
  createConversationDeliveryTestStore,
  holdConversationWriterForTest,
  queueConversationDeliveryForTest as persistIntent,
  readConversationDeliveryStateForTest,
} from "./conversation-delivery.test-support.js";
import { ConversationInputError } from "./conversation-errors.js";
import { runGatewayConversationTurn } from "./conversation-turn.js";

function sentResult(messageId = "reef-outbound-1") {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: conversation.target,
    handledBy: "core",
    payload: {},
    deliveredText: "hello molty",
    sendResult: {
      channel: "reef",
      to: conversation.target,
      via: "direct",
      mediaUrl: null,
      result: { messageId },
      deliveryStatus: "sent",
    },
    dryRun: false,
  } satisfies Extract<MessageActionResult, { kind: "send" }>;
}

async function createDeps() {
  const store = await createConversationDeliveryTestStore();
  const entry = await upsertSessionEntryCore(
    { ...store.scope, sessionKey: conversation.sessionKey },
    {
      sessionId: conversation.sessionId,
      updatedAt: conversation.lastSeenAt,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: conversation.channel,
          accountId: conversation.accountId,
          to: conversation.target,
        },
      }),
    },
  );
  return {
    ...store,
    entry,
    beginOperation: vi.spyOn(deliveryStore, "beginConversationDeliveryOperation"),
    getOperation: vi.spyOn(deliveryStore, "getConversationDeliveryOperation"),
    markSent: vi.spyOn(deliveryStore, "markConversationDeliverySent"),
    markSuppressed: vi.spyOn(deliveryStore, "markConversationDeliverySuppressed"),
    registerPendingConversationTurn: vi.spyOn(conversationTurns, "registerPendingConversationTurn"),
    readConversation: vi
      .spyOn(conversationRegistry, "readConversation")
      .mockResolvedValue(conversation),
    resolveOutboundChannelPlugin: vi
      .spyOn(channelResolution, "resolveOutboundChannelPlugin")
      .mockImplementation(
        () =>
          ({
            outbound: { prepareConversationTurnMessageId: () => "reef-outbound-1" },
          }) as never,
      ),
    resolveOutboundSessionRoute: vi
      .spyOn(outboundSession, "resolveOutboundSessionRoute")
      .mockImplementation(async () => ({
        sessionKey: conversation.sessionKey,
        baseSessionKey: conversation.sessionKey,
        peer: { kind: "direct" as const, id: "molty" },
        chatType: "direct" as const,
        from: "reef:molty",
        to: conversation.target,
      })),
    bindOutboundSessionEntry: vi
      .spyOn(outboundSession, "bindOutboundSessionEntry")
      .mockImplementation(async () => undefined),
    runMessageAction: vi
      .spyOn(messageActionRunner, "runMessageAction")
      .mockImplementation(async () => sentResult()),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("runGatewayConversationTurn", () => {
  it("replays a completed turn without inspecting its source session store", async () => {
    const deps = await createDeps();
    const directory = path.dirname(deps.scope.storePath);
    const storePattern = path.join(directory, "{agentId}.sqlite");
    const scope = { agentId: "main", storePath: path.join(directory, "main.sqlite") };
    const sourceStore = path.join(directory, "source.sqlite");
    const sourceSessionKey = "agent:source:main";
    await registerConversationAddresses(scope, [
      { ...conversation, deliveryTarget: conversation.target },
    ]);
    await beginConversationDeliveryOperation(scope, {
      operationId: "turn-source-replay",
      operationKind: "turn",
      sourceSessionKey,
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "sent-id",
    });
    await markConversationDeliverySent(scope, "turn-source-replay", "sent-id");
    fs.writeFileSync(sourceStore, "source storage is unavailable");
    const inspect = agentDatabase.inspectOpenClawAgentDatabaseOwner;
    const inspectSource = vi
      .spyOn(agentDatabase, "inspectOpenClawAgentDatabaseOwner")
      .mockImplementation((pathname) => {
        if (pathname === sourceStore) {
          throw new Error("completed retry must not inspect source storage");
        }
        return inspect(pathname);
      });
    try {
      await expect(
        runGatewayConversationTurn({
          config: { session: { store: storePattern } },
          agentId: "main",
          senderIsOwner: true,
          sourceSessionKey,
          turnId: "turn-source-replay",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1,
        }),
      ).resolves.toMatchObject({ status: "sent", messageId: "sent-id" });
      expect(inspectSource).not.toHaveBeenCalledWith(sourceStore);
      expect(deps.bindOutboundSessionEntry).not.toHaveBeenCalled();
      expect(deps.runMessageAction).not.toHaveBeenCalled();
    } finally {
      inspectSource.mockRestore();
      await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    }
  });

  it("waits for the writer before its initial writable operation lookup", async () => {
    const deps = await createDeps();
    const scope = await prepareConversationRegistryScope({ agentId: "main", config: deps.config });
    const writer = holdConversationWriterForTest(scope);
    await writer.entered;
    const turn = runGatewayConversationTurn({
      config: deps.config,
      agentId: "main",
      senderIsOwner: true,
      turnId: "turn-admitted-lookup",
      conversationRef: conversation.conversationRef,
      message: "hello",
      timeoutMs: 1,
    });
    const outcome = turn.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await setImmediate();
      expect(
        readConversationDeliveryStateForTest(deps.scope, "turn-admitted-lookup"),
      ).toBeUndefined();
      expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
      expect(deps.runMessageAction).not.toHaveBeenCalled();
      await writer.release();
      expect(await outcome).toMatchObject({ value: { status: "timeout" } });
    } finally {
      try {
        await writer.release();
      } finally {
        await outcome;
      }
    }
  });

  it("refuses a replaced session at admitted turn creation", async () => {
    const deps = await createDeps();
    const scope = await prepareConversationRegistryScope({ agentId: "main", config: deps.config });
    const blocked = createDeferred<ReturnType<typeof holdConversationWriterForTest>>();
    deps.readConversation.mockImplementationOnce(async () => {
      const writer = holdConversationWriterForTest(scope);
      blocked.resolve(writer);
      return conversation;
    });
    const turn = runGatewayConversationTurn({
      config: deps.config,
      agentId: "main",
      senderIsOwner: true,
      turnId: "turn-admitted-generation",
      conversationRef: conversation.conversationRef,
      message: "hello",
      timeoutMs: 1,
    });
    const outcome = turn.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const writerReady = Promise.race([blocked.promise, outcome.then(() => undefined)]);
    try {
      const writer = await writerReady;
      if (!writer) {
        throw new Error("Conversation turn settled before reaching its creation writer", {
          cause: await outcome,
        });
      }
      await writer.entered;
      replaceSessionEntrySync(
        { ...deps.scope, sessionKey: conversation.sessionKey },
        { ...deps.entry!, sessionId: "replacement" },
      );
      deps.readConversation.mockResolvedValue({ ...conversation, sessionId: "replacement" });
      await setImmediate();
      expect(
        readConversationDeliveryStateForTest(deps.scope, "turn-admitted-generation"),
      ).toBeUndefined();
      await writer.release();
      expect(await outcome).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringContaining("Conversation is no longer available"),
        }),
      });
      expect(
        readConversationDeliveryStateForTest(deps.scope, "turn-admitted-generation"),
      ).toBeUndefined();
      expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
      expect(deps.runMessageAction).not.toHaveBeenCalled();
    } finally {
      const writer = await writerReady;
      try {
        await writer?.release();
      } finally {
        await outcome;
      }
    }
  });

  it("creates a context binding only when a discovered address starts a turn", async () => {
    const deps = await createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.readConversation.mockResolvedValueOnce(unbound).mockResolvedValue(conversation);
    deps.bindOutboundSessionEntry.mockImplementationOnce(async (params) => {
      params.workerGuard?.assertCurrent?.();
    });
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      return sentResult();
    });

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-directory-peer",
        sourceSessionKey: "agent:main:dashboard:restricted-creator",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
        timeoutMs: 1,
      }),
    ).resolves.toMatchObject({ status: "timeout" });

    expect(deps.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "reef", target: "reef:molty" }),
    );
    expect(deps.bindOutboundSessionEntry).toHaveBeenCalledOnce();
    expect(deps.bindOutboundSessionEntry.mock.calls[0]?.[0]).toMatchObject({
      sourceSessionKey: "agent:main:dashboard:restricted-creator",
    });
    expect(deps.registerPendingConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: conversation.sessionId }),
    );
  });

  it("rejects a route-owner change at the outbound session binding commit", async () => {
    const deps = await createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.readConversation.mockResolvedValue(unbound);
    deps.bindOutboundSessionEntry.mockImplementationOnce(async (params) => {
      params.workerGuard?.assertCurrent?.();
    });
    const readCurrentConfig = vi
      .fn()
      .mockReturnValueOnce(deps.config)
      .mockReturnValue({
        ...deps.config,
        agents: { entries: { main: {}, finance: {} } },
        bindings: [
          {
            type: "route",
            agentId: "finance",
            match: { channel: "reef", accountId: "default" },
          },
        ],
      });

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        readCurrentConfig,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-revoked-during-bind",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expect(
      readConversationDeliveryStateForTest(deps.scope, "turn-revoked-during-bind"),
    ).toBeUndefined();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("registers correlation before durable delivery and consumes a fast reply inline", async () => {
    const deps = await createDeps();
    let capture: Promise<void> | undefined;
    deps.runMessageAction.mockImplementation(async (input) => {
      expect(input).toMatchObject({
        preparedMessageId: "reef-outbound-1",
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
      });
      await persistIntent(input);
      capture = claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: conversation.conversationRef,
        sessionId: conversation.sessionId,
        messageId: "reef-inbound-1",
        replyToId: "reef-outbound-1",
        text: "hello clawd",
        timestamp: 300,
      }).then((claim) => claim?.complete());
      return sentResult();
    });

    const result = await runGatewayConversationTurn({
      config: deps.config,
      agentId: "main",
      senderIsOwner: true,
      sourceSessionKey: "agent:main:telegram:direct:operator",
      turnId: "turn-fast-reply",
      conversationRef: conversation.conversationRef,
      message: "hello molty",
      timeoutMs: 1_000,
    });
    await capture;

    expect(result).toMatchObject({
      status: "replied",
      messageId: "reef-outbound-1",
      reply: { text: "hello clawd", replyToId: "reef-outbound-1" },
    });
    expect(deps.registerPendingConversationTurn.mock.invocationCallOrder[0]).toBeLessThan(
      deps.runMessageAction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("uses the durable prepared id when another process creates the operation during preflight", async () => {
    const deps = await createDeps();
    let capture: Promise<void> | undefined;
    let competingOperation: ReturnType<typeof beginConversationDeliveryOperation> | undefined;
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          competingOperation = beginConversationDeliveryOperation(deps.scope, {
            operationId: "turn-raced",
            operationKind: "turn",
            conversationRef: conversation.conversationRef,
            message: "hello molty",
            preparedMessageId: "reef-authoritative-a",
          });
          void competingOperation.catch(() => undefined);
          return "reef-candidate-b";
        },
      },
    } as never);
    deps.runMessageAction.mockImplementation(async (input) => {
      expect(input).toMatchObject({ preparedMessageId: "reef-authoritative-a" });
      await persistIntent(input);
      capture = claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: conversation.conversationRef,
        sessionId: conversation.sessionId,
        messageId: "reef-inbound-race",
        replyToId: "reef-authoritative-a",
        text: "durable id acknowledged",
        timestamp: 300,
      }).then((claim) => claim?.complete());
      return sentResult("reef-authoritative-a");
    });

    const result = await runGatewayConversationTurn({
      config: deps.config,
      agentId: "main",
      senderIsOwner: true,
      turnId: "turn-raced",
      conversationRef: conversation.conversationRef,
      message: "hello molty",
      timeoutMs: 1_000,
    });
    await competingOperation;
    await capture;

    expect(result).toMatchObject({
      status: "replied",
      messageId: "reef-authoritative-a",
      reply: { text: "durable id acknowledged", replyToId: "reef-authoritative-a" },
    });
  });

  it("returns a prior durable reply without sending again", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-replied",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-1",
    });
    await markConversationDeliverySent(deps.scope, "turn-replied", "reef-outbound-1");
    await markConversationDeliveryReplied(deps.scope, {
      operationId: "turn-replied",
      reply: { messageId: "reply-1", replyToId: "reef-outbound-1", text: "ack", timestamp: 300 },
    });
    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-replied",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "replied", reply: { text: "ack" } });
    expect(deps.readConversation).toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("does not reveal a completed reply after the route owner changes", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-reassigned",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-1",
    });
    await markConversationDeliverySent(deps.scope, "turn-reassigned", "reef-outbound-1");
    await markConversationDeliveryReplied(deps.scope, {
      operationId: "turn-reassigned",
      reply: {
        messageId: "reply-private",
        replyToId: "reef-outbound-1",
        text: "private finance reply",
        timestamp: 300,
      },
    });

    await expect(
      runGatewayConversationTurn({
        config: {
          ...deps.config,
          agents: { entries: { main: {}, finance: {} } },
          bindings: [
            {
              type: "route",
              agentId: "finance",
              match: { channel: "reef", accountId: "default" },
            },
          ],
        },
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-reassigned",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ConversationInputError);
  });

  it("returns a durable permanent rejection as invalid input after restart", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-rejected",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-1",
    });
    await markConversationDeliveryQueued(deps.scope, "turn-rejected", "queue-rejected");
    await markConversationDeliveryRejected(deps.scope, "turn-rejected", "atomic message limit");

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-rejected",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("classifies durable operation-id input reuse as invalid input", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-reused",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "original",
      preparedMessageId: "reef-outbound-reused",
    });
    await markConversationDeliverySent(deps.scope, "turn-reused");
    deps.readConversation.mockResolvedValue(undefined);

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-reused",
        conversationRef: conversation.conversationRef,
        message: "different",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "ConversationOperationConflictError",
      message: expect.stringContaining("reused with different input"),
    });
    expect(deps.readConversation.mock.calls.length).toBe(0);
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("requires a live binding before resuming an unfinished durable turn", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-created",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-created",
    });
    deps.readConversation.mockResolvedValue(undefined);

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-created",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects delivery after the admitted session generation is replaced", async () => {
    const deps = await createDeps();
    let current = conversation;
    deps.readConversation.mockImplementation(async () => current);
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      current = {
        ...conversation,
        sessionId: "replacement-session",
      };
      await upsertSessionEntryCore(
        { ...deps.scope, sessionKey: conversation.sessionKey },
        { sessionId: current.sessionId },
      );
      try {
        await input.withDirectAdapterHandoff?.(async () => undefined);
      } catch (error) {
        await markConversationDeliveryRejected(
          deps.scope,
          "turn-replaced-session",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      return sentResult();
    });

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-replaced-session",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ name: "ConversationInputError" });
    expect(deps.runMessageAction).toHaveBeenCalledOnce();
  });

  it("rejects unsupported channels before registering or sending", async () => {
    const deps = await createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.readConversation.mockResolvedValue(unbound);
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({ outbound: {} } as never);

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-unsupported",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(deps.bindOutboundSessionEntry).not.toHaveBeenCalled();
    expect(readConversationDeliveryStateForTest(deps.scope, "turn-unsupported")).toBeUndefined();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects channel preflight before creating a durable operation", async () => {
    const deps = await createDeps();
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          throw new Error("atomic message limit");
        },
      },
    } as never);

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-preflight-rejected",
        conversationRef: conversation.conversationRef,
        message: "oversized",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expect(
      readConversationDeliveryStateForTest(deps.scope, "turn-preflight-rejected"),
    ).toBeUndefined();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("disables inline correlation when delivery changes the reserved id", async () => {
    const deps = await createDeps();
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      return sentResult("reef-different-id");
    });

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-wrong-id",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: "sent",
      messageId: "reef-different-id",
      error: expect.stringContaining("did not preserve its prepared message id"),
    });
  });

  it("returns suppression without promoting it to sent", async () => {
    const deps = await createDeps();
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input, "queue-suppressed");
      return {
        ...sentResult(),
        sendResult: { ...sentResult().sendResult, deliveryStatus: "suppressed" as const },
      };
    });

    await expect(
      runGatewayConversationTurn({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-suppressed",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "suppressed", correlationPersisted: false });
  });
});
