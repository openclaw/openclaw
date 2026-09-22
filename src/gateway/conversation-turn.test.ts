import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
} from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversationRegistryScope,
  registerConversationAddresses,
  type ConversationRecord,
} from "../config/sessions/conversation-registry.js";
import type { ConversationDeliveryDeps } from "../infra/outbound/conversation-delivery.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import {
  claimPendingConversationTurnReply,
  registerPendingConversationTurn,
} from "../sessions/conversation-turns.js";
import * as agentDatabase from "../state/openclaw-agent-db.js";
import {
  conversation,
  createConversationDeliveryTestStore,
  holdConversationWriterForTest,
  queueConversationDeliveryForTest as persistIntent,
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

function createDeps() {
  return {
    ...createConversationDeliveryTestStore(),
    registerPendingConversationTurn: vi.fn(registerPendingConversationTurn),
    resolveConversation: vi.fn((): ConversationRecord | undefined => conversation),
    resolveOutboundChannelPlugin: vi.fn(
      () =>
        ({
          outbound: { prepareConversationTurnMessageId: () => "reef-outbound-1" },
        }) as never,
    ),
    resolveOutboundSessionRoute: vi.fn(async () => ({
      sessionKey: conversation.sessionKey,
      baseSessionKey: conversation.sessionKey,
      peer: { kind: "direct" as const, id: "molty" },
      chatType: "direct" as const,
      from: "reef:molty",
      to: conversation.target,
    })),
    bindOutboundSessionEntry: vi.fn(
      async (_params: { assertCommitAllowed?: () => void }) => undefined,
    ),
    runMessageAction: vi.fn<ConversationDeliveryDeps["runMessageAction"]>(async () => sentResult()),
  };
}

describe("runGatewayConversationTurn", () => {
  it("replays a completed turn without inspecting its source session store", async () => {
    const deps = createDeps();
    const directory = path.dirname(deps.scope.storePath);
    const storePattern = path.join(directory, "{agentId}.sqlite");
    const scope = { agentId: "main", storePath: path.join(directory, "main.sqlite") };
    const sourceStore = path.join(directory, "source.sqlite");
    const sourceSessionKey = "agent:source:main";
    registerConversationAddresses(scope, [
      { ...conversation, deliveryTarget: conversation.target },
    ]);
    beginConversationDeliveryOperation(scope, {
      operationId: "turn-source-replay",
      operationKind: "turn",
      sourceSessionKey,
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "sent-id",
    });
    markConversationDeliverySent(scope, "turn-source-replay", "sent-id");
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
        runGatewayConversationTurn(
          {
            config: { session: { store: storePattern } },
            agentId: "main",
            senderIsOwner: true,
            sourceSessionKey,
            turnId: "turn-source-replay",
            conversationRef: conversation.conversationRef,
            message: "hello",
            timeoutMs: 1,
          },
          deps,
        ),
      ).resolves.toMatchObject({ status: "sent", messageId: "sent-id" });
      expect(inspectSource).not.toHaveBeenCalledWith(sourceStore);
      expect(deps.bindOutboundSessionEntry).not.toHaveBeenCalled();
      expect(deps.runMessageAction).not.toHaveBeenCalled();
    } finally {
      inspectSource.mockRestore();
      agentDatabase.closeOpenClawAgentDatabaseByPath(scope.storePath);
    }
  });

  it("waits for the writer before its initial writable operation lookup", async () => {
    const deps = createDeps();
    const scope = resolveConversationRegistryScope({ agentId: "main", config: deps.config });
    const writer = holdConversationWriterForTest(scope);
    await writer.entered;
    const turn = runGatewayConversationTurn(
      {
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-admitted-lookup",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1,
      },
      deps,
    );
    const outcome = turn.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await setImmediate();
      expect(deps.getOperation.mock.calls.length).toBe(0);
      expect(deps.beginOperation.mock.calls.length).toBe(0);
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
    const deps = createDeps();
    const scope = resolveConversationRegistryScope({ agentId: "main", config: deps.config });
    const blocked = createDeferred<ReturnType<typeof holdConversationWriterForTest>>();
    deps.resolveConversation.mockImplementationOnce(() => {
      const writer = holdConversationWriterForTest(scope);
      blocked.resolve(writer);
      return conversation;
    });
    const turn = runGatewayConversationTurn(
      {
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-admitted-generation",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1,
      },
      deps,
    );
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
      deps.resolveConversation.mockReturnValue({ ...conversation, sessionId: "replacement" });
      await setImmediate();
      expect(deps.beginOperation.mock.calls.length).toBe(0);
      await writer.release();
      expect(await outcome).toMatchObject({ error: expect.any(PlatformMessageNotDispatchedError) });
      expect(deps.beginOperation.mock.calls.length).toBe(0);
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

  it("rejects a stored conversation route owned by another agent", async () => {
    const deps = createDeps();

    await expect(
      runGatewayConversationTurn(
        {
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
          turnId: "turn-sibling-route",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
    expect(deps.beginOperation.mock.calls.length).toBe(0);
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("creates a context binding only when a discovered address starts a turn", async () => {
    const deps = createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.resolveConversation.mockReturnValueOnce(unbound).mockReturnValue(conversation);
    deps.bindOutboundSessionEntry.mockImplementationOnce(
      async (params: { assertCommitAllowed?: () => void }) => {
        params.assertCommitAllowed?.();
      },
    );
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      return sentResult();
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-directory-peer",
          sourceSessionKey: "agent:main:dashboard:restricted-creator",
          conversationRef: conversation.conversationRef,
          message: "hello molty",
          timeoutMs: 1,
        },
        deps,
      ),
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
    const deps = createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.resolveConversation.mockReturnValue(unbound);
    deps.bindOutboundSessionEntry.mockImplementationOnce(
      async (params: { assertCommitAllowed?: () => void }) => {
        params.assertCommitAllowed?.();
      },
    );
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
      runGatewayConversationTurn(
        {
          config: deps.config,
          readCurrentConfig,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-revoked-during-bind",
          conversationRef: conversation.conversationRef,
          message: "hello molty",
          timeoutMs: 1,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expect(deps.beginOperation.mock.calls.length).toBe(0);
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("registers correlation before durable delivery and consumes a fast reply inline", async () => {
    const deps = createDeps();
    let capture: Promise<void> | undefined;
    deps.runMessageAction.mockImplementation(async (input) => {
      expect(input).toMatchObject({
        preparedMessageId: "reef-outbound-1",
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        suppressTranscriptMirror: true,
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

    const result = await runGatewayConversationTurn(
      {
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        turnId: "turn-fast-reply",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
        timeoutMs: 1_000,
      },
      deps,
    );
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
    const deps = createDeps();
    let capture: Promise<void> | undefined;
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          beginConversationDeliveryOperation(deps.scope, {
            operationId: "turn-raced",
            operationKind: "turn",
            conversationRef: conversation.conversationRef,
            message: "hello molty",
            preparedMessageId: "reef-authoritative-a",
          });
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

    const result = await runGatewayConversationTurn(
      {
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-raced",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
        timeoutMs: 1_000,
      },
      deps,
    );
    await capture;

    expect(result).toMatchObject({
      status: "replied",
      messageId: "reef-authoritative-a",
      reply: { text: "durable id acknowledged", replyToId: "reef-authoritative-a" },
    });
  });

  it("returns a prior durable reply without sending again", async () => {
    const deps = createDeps();
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-replied",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-1",
    });
    markConversationDeliverySent(deps.scope, "turn-replied", "reef-outbound-1");
    markConversationDeliveryReplied(deps.scope, {
      operationId: "turn-replied",
      reply: { messageId: "reply-1", replyToId: "reef-outbound-1", text: "ack", timestamp: 300 },
    });
    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-replied",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "replied", reply: { text: "ack" } });
    expect(deps.resolveConversation).toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("does not reveal a completed reply after the route owner changes", async () => {
    const deps = createDeps();
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-reassigned",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-1",
    });
    markConversationDeliverySent(deps.scope, "turn-reassigned", "reef-outbound-1");
    markConversationDeliveryReplied(deps.scope, {
      operationId: "turn-reassigned",
      reply: {
        messageId: "reply-private",
        replyToId: "reef-outbound-1",
        text: "private finance reply",
        timestamp: 300,
      },
    });

    await expect(
      runGatewayConversationTurn(
        {
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
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
  });

  it("returns queued state without retrying recipient-visible I/O", async () => {
    const deps = createDeps();
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-queued",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-1",
    });
    markConversationDeliveryQueued(deps.scope, "turn-queued", "queue-existing");

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-queued",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "queued", messageId: "reef-outbound-1" });
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("returns a durable permanent rejection as invalid input after restart", async () => {
    const deps = createDeps();
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-rejected",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-1",
    });
    markConversationDeliveryQueued(deps.scope, "turn-rejected", "queue-rejected");
    markConversationDeliveryRejected(deps.scope, "turn-rejected", "atomic message limit");

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-rejected",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("classifies durable operation-id input reuse as invalid input", async () => {
    const deps = createDeps();
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-reused",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "original",
      preparedMessageId: "reef-outbound-reused",
    });
    markConversationDeliverySent(deps.scope, "turn-reused");
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-reused",
          conversationRef: conversation.conversationRef,
          message: "different",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationOperationConflictError",
      message: expect.stringContaining("reused with different input"),
    });
    expect(deps.resolveConversation.mock.calls.length).toBe(0);
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("requires a live binding before resuming an unfinished durable turn", async () => {
    const deps = createDeps();
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "turn-created",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      message: "hello",
      preparedMessageId: "reef-outbound-created",
    });
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-created",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("classifies a final rendered provider rejection as invalid input", async () => {
    const deps = createDeps();
    deps.runMessageAction.mockImplementation(async () => {
      markConversationDeliveryRejected(
        deps.scope,
        "turn-rendered-rejected",
        "atomic message limit",
      );
      throw new PlatformMessageNotDispatchedError("atomic message limit", {
        cause: new Error("rendered text is too large"),
        retryable: false,
      });
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-rendered-rejected",
          conversationRef: conversation.conversationRef,
          message: "raw text passed preflight",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
  });

  it("rejects delivery after the admitted session generation is replaced", async () => {
    const deps = createDeps();
    let current = conversation;
    deps.resolveConversation.mockImplementation(() => current);
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      current = {
        ...conversation,
        sessionId: "replacement-session",
        sessionKey: "agent:main:reef:direct:replacement",
      };
      try {
        await (input.onDeliveryAttempt as () => Promise<void>)();
      } catch (error) {
        markConversationDeliveryRejected(
          deps.scope,
          "turn-replaced-session",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      return sentResult();
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-replaced-session",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({ name: "ConversationInputError" });
    expect(deps.runMessageAction).toHaveBeenCalledOnce();
  });

  it("rejects unsupported channels before registering or sending", async () => {
    const deps = createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.resolveConversation.mockReturnValue(unbound);
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({ outbound: {} } as never);

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-unsupported",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(deps.bindOutboundSessionEntry).not.toHaveBeenCalled();
    expect(deps.beginOperation.mock.calls.length).toBe(0);
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects channel preflight before creating a durable operation", async () => {
    const deps = createDeps();
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          throw new Error("atomic message limit");
        },
      },
    } as never);

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-preflight-rejected",
          conversationRef: conversation.conversationRef,
          message: "oversized",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expect(deps.beginOperation.mock.calls.length).toBe(0);
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("disables inline correlation when delivery changes the reserved id", async () => {
    const deps = createDeps();
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      return sentResult("reef-different-id");
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-wrong-id",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({
      status: "sent",
      messageId: "reef-different-id",
      error: expect.stringContaining("did not preserve its prepared message id"),
    });
  });

  it("returns suppression without promoting it to sent", async () => {
    const deps = createDeps();
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input, "queue-suppressed");
      return {
        ...sentResult(),
        sendResult: { ...sentResult().sendResult, deliveryStatus: "suppressed" as const },
      };
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-suppressed",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "suppressed", correlationPersisted: false });
  });
});
