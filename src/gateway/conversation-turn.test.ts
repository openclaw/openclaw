import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
} from "../config/sessions/conversation-delivery-store.js";
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
import {
  captureOutcome,
  reassignedConfig,
  releaseAndDrain,
  sentTurnResult as sentResult,
} from "./conversation-send-turn.test-support.js";
import { runGatewayConversationTurn } from "./conversation-turn.js";

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
    registerPendingConversationTurn: vi.spyOn(conversationTurns, "registerPendingConversationTurn"),
    readConversation: vi
      .spyOn(conversationRegistry, "readConversation")
      .mockResolvedValue(conversation),
    resolveOutboundChannelPlugin: vi
      .spyOn(channelResolution, "resolveOutboundChannelPlugin")
      .mockReturnValue({
        outbound: { prepareConversationTurnMessageId: () => "reef-outbound-1" },
      } as never),
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

let deps: Awaited<ReturnType<typeof createDeps>>;
afterEach(() => vi.restoreAllMocks());

type TurnInput = Parameters<typeof runGatewayConversationTurn>[0];
function runTurn(turnId: string, overrides: Partial<TurnInput> = {}) {
  return runGatewayConversationTurn({
    config: deps.config,
    agentId: "main",
    senderIsOwner: true,
    conversationRef: conversation.conversationRef,
    message: "hello",
    timeoutMs: 1_000,
    turnId,
    ...overrides,
  });
}

function beginTurn(
  scope: Parameters<typeof beginConversationDeliveryOperation>[0],
  operationId: string,
  overrides: Partial<Parameters<typeof beginConversationDeliveryOperation>[1]> = {},
) {
  return beginConversationDeliveryOperation(scope, {
    operationId,
    operationKind: "turn",
    conversationRef: conversation.conversationRef,
    message: "hello",
    preparedMessageId: "reef-outbound-1",
    ...overrides,
  });
}

function unboundConversation() {
  const { sessionId: _sessionId, sessionKey: _sessionKey, role: _role, ...unbound } = conversation;
  return unbound;
}

function expectNotCalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectNoOperation(turnId: string) {
  expect(readConversationDeliveryStateForTest(deps.scope, turnId)).toBeUndefined();
}

async function recordReply(operationId: string, text: string, messageId = "reply-1") {
  await beginTurn(deps.scope, operationId);
  await markConversationDeliverySent(deps.scope, operationId, "reef-outbound-1");
  await markConversationDeliveryReplied(deps.scope, {
    operationId,
    reply: { messageId, replyToId: "reef-outbound-1", text, timestamp: 300 },
  });
}

function claimReply(replyToId: string, text: string, messageId = "reef-inbound-1") {
  return claimPendingConversationTurnReply({
    agentId: "main",
    conversationRef: conversation.conversationRef,
    sessionId: conversation.sessionId,
    messageId,
    replyToId,
    text,
    timestamp: 300,
  }).then((claim) => claim?.complete());
}

describe("runGatewayConversationTurn", () => {
  beforeEach(async () => {
    deps = await createDeps();
  });

  it("replays a completed turn without inspecting its source session store", async () => {
    const directory = path.dirname(deps.scope.storePath);
    const storePattern = path.join(directory, "{agentId}.sqlite");
    const scope = { agentId: "main", storePath: path.join(directory, "main.sqlite") };
    const sourceStore = path.join(directory, "source.sqlite");
    const sourceSessionKey = "agent:source:main";
    await registerConversationAddresses(scope, [
      { ...conversation, deliveryTarget: conversation.target },
    ]);
    await beginTurn(scope, "turn-source-replay", {
      sourceSessionKey,
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
        runTurn("turn-source-replay", {
          config: { session: { store: storePattern } },
          sourceSessionKey,
          timeoutMs: 1,
        }),
      ).resolves.toMatchObject({ status: "sent", messageId: "sent-id" });
      expect(inspectSource).not.toHaveBeenCalledWith(sourceStore);
      expectNotCalled(deps.bindOutboundSessionEntry, deps.runMessageAction);
    } finally {
      inspectSource.mockRestore();
      await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    }
  });

  it("waits for the writer before its initial writable operation lookup", async () => {
    const scope = await prepareConversationRegistryScope({ agentId: "main", config: deps.config });
    const writer = holdConversationWriterForTest(scope);
    await writer.entered;
    const turn = runTurn("turn-admitted-lookup", {
      timeoutMs: 1,
    });
    const outcome = captureOutcome(turn);
    try {
      await setImmediate();
      expectNoOperation("turn-admitted-lookup");
      expectNotCalled(deps.registerPendingConversationTurn, deps.runMessageAction);
      await writer.release();
      expect(await outcome).toMatchObject({ value: { status: "timeout" } });
    } finally {
      await releaseAndDrain(() => writer.release(), outcome);
    }
  });

  it("refuses a replaced session at admitted turn creation", async () => {
    const scope = await prepareConversationRegistryScope({ agentId: "main", config: deps.config });
    const blocked = createDeferred<ReturnType<typeof holdConversationWriterForTest>>();
    deps.readConversation.mockImplementationOnce(async () => {
      const writer = holdConversationWriterForTest(scope);
      blocked.resolve(writer);
      return conversation;
    });
    const turn = runTurn("turn-admitted-generation", {
      timeoutMs: 1,
    });
    const outcome = captureOutcome(turn);
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
      expectNoOperation("turn-admitted-generation");
      await writer.release();
      expect(await outcome).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringContaining("Conversation is no longer available"),
        }),
      });
      expectNoOperation("turn-admitted-generation");
      expectNotCalled(deps.registerPendingConversationTurn, deps.runMessageAction);
    } finally {
      const writer = await writerReady;
      await releaseAndDrain(async () => writer?.release(), outcome);
    }
  });

  it("creates a context binding only when a discovered address starts a turn", async () => {
    deps.readConversation
      .mockResolvedValueOnce(unboundConversation())
      .mockResolvedValue(conversation);
    deps.bindOutboundSessionEntry.mockImplementationOnce(async (params) => {
      params.workerGuard?.assertCurrent?.();
    });
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      return sentResult();
    });

    await expect(
      runTurn("turn-directory-peer", {
        sourceSessionKey: "agent:main:dashboard:restricted-creator",
        message: "hello molty",
        timeoutMs: 1,
      }),
    ).resolves.toMatchObject({ status: "timeout" });

    expect(deps.bindOutboundSessionEntry.mock.calls[0]?.[0]).toMatchObject({
      sourceSessionKey: "agent:main:dashboard:restricted-creator",
    });
    expect(deps.registerPendingConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: conversation.sessionId }),
    );
  });

  it("rejects a route-owner change at the outbound session binding commit", async () => {
    deps.readConversation.mockResolvedValue(unboundConversation());
    deps.bindOutboundSessionEntry.mockImplementationOnce(async (params) => {
      params.workerGuard?.assertCurrent?.();
    });
    const readCurrentConfig = vi
      .fn()
      .mockReturnValueOnce(deps.config)
      .mockReturnValue(reassignedConfig(deps.config));

    await expect(
      runTurn("turn-revoked-during-bind", {
        readCurrentConfig,
        message: "hello molty",
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expectNoOperation("turn-revoked-during-bind");
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("correlates a fast reply with the durable id won by another process during preflight", async () => {
    let capture: Promise<void> | undefined;
    let competingOperation: ReturnType<typeof beginConversationDeliveryOperation> | undefined;
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          competingOperation = beginTurn(deps.scope, "turn-raced", {
            message: "hello molty",
            preparedMessageId: "reef-authoritative-a",
          });
          void competingOperation.catch(() => undefined);
          return "reef-candidate-b";
        },
      },
    } as never);
    deps.runMessageAction.mockImplementation(async (input) => {
      expect(input).toMatchObject({
        preparedMessageId: "reef-authoritative-a",
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        suppressTranscriptMirror: true,
      });
      await persistIntent(input);
      capture = claimReply("reef-authoritative-a", "durable id acknowledged", "reef-inbound-race");
      return sentResult("reef-authoritative-a");
    });

    const result = await runTurn("turn-raced", {
      message: "hello molty",
    });
    await competingOperation;
    await capture;

    expect(result).toMatchObject({
      status: "replied",
      messageId: "reef-authoritative-a",
      reply: { text: "durable id acknowledged", replyToId: "reef-authoritative-a" },
    });
    expect(deps.registerPendingConversationTurn.mock.invocationCallOrder[0]).toBeLessThan(
      deps.runMessageAction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("replays a durable reply without sending again, but withholds it from a new route owner", async () => {
    await recordReply("turn-replied", "ack");
    await expect(runTurn("turn-replied")).resolves.toMatchObject({
      status: "replied",
      reply: { text: "ack" },
    });
    expectNotCalled(deps.runMessageAction, deps.resolveOutboundChannelPlugin);
    await expect(
      runTurn("turn-replied", {
        config: reassignedConfig(deps.config),
      }),
    ).rejects.toBeInstanceOf(ConversationInputError);
  });

  it("returns a durable permanent rejection as invalid input after restart", async () => {
    await beginTurn(deps.scope, "turn-rejected");
    await markConversationDeliveryQueued(deps.scope, "turn-rejected", "queue-rejected");
    await markConversationDeliveryRejected(deps.scope, "turn-rejected", "atomic message limit");

    await expect(runTurn("turn-rejected")).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expectNotCalled(deps.runMessageAction, deps.resolveOutboundChannelPlugin);
  });

  it("classifies durable operation-id input reuse as invalid input", async () => {
    await beginTurn(deps.scope, "turn-reused", {
      message: "original",
      preparedMessageId: "reef-outbound-reused",
    });
    await markConversationDeliverySent(deps.scope, "turn-reused");
    deps.readConversation.mockResolvedValue(undefined);

    await expect(
      runTurn("turn-reused", {
        message: "different",
      }),
    ).rejects.toMatchObject({
      name: "ConversationOperationConflictError",
      message: expect.stringContaining("reused with different input"),
    });
    expect(deps.readConversation.mock.calls.length).toBe(0);
    expectNotCalled(deps.registerPendingConversationTurn, deps.runMessageAction);
  });

  it("requires a live binding before resuming an unfinished durable turn", async () => {
    await beginTurn(deps.scope, "turn-created", {
      preparedMessageId: "reef-outbound-created",
    });
    deps.readConversation.mockResolvedValue(undefined);

    await expect(runTurn("turn-created")).rejects.toBeInstanceOf(ConversationInputError);
    expectNotCalled(
      deps.resolveOutboundChannelPlugin,
      deps.registerPendingConversationTurn,
      deps.runMessageAction,
    );
  });

  it("rejects delivery after the admitted session generation is replaced", async () => {
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

    await expect(runTurn("turn-replaced-session")).rejects.toMatchObject({
      name: "ConversationInputError",
    });
    expect(deps.runMessageAction).toHaveBeenCalledOnce();
  });

  it("rejects unsupported channels before registering or sending", async () => {
    deps.readConversation.mockResolvedValue(unboundConversation());
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({ outbound: {} } as never);

    await expect(runTurn("turn-unsupported")).rejects.toBeInstanceOf(ConversationInputError);
    expectNotCalled(deps.resolveOutboundSessionRoute, deps.bindOutboundSessionEntry);
    expectNoOperation("turn-unsupported");
    expectNotCalled(deps.registerPendingConversationTurn, deps.runMessageAction);
  });

  it("rejects channel preflight before creating a durable operation", async () => {
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          throw new Error("atomic message limit");
        },
      },
    } as never);

    await expect(
      runTurn("turn-preflight-rejected", {
        message: "oversized",
      }),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expectNoOperation("turn-preflight-rejected");
    expectNotCalled(deps.registerPendingConversationTurn, deps.runMessageAction);
  });

  it("disables inline correlation when delivery changes the reserved id", async () => {
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input);
      return sentResult("reef-different-id");
    });

    await expect(runTurn("turn-wrong-id")).resolves.toMatchObject({
      status: "sent",
      messageId: "reef-different-id",
      error: expect.stringContaining("did not preserve its prepared message id"),
    });
  });

  it("returns suppression without promoting it to sent", async () => {
    deps.runMessageAction.mockImplementation(async (input) => {
      await persistIntent(input, "queue-suppressed");
      return {
        ...sentResult(),
        sendResult: { ...sentResult().sendResult, deliveryStatus: "suppressed" as const },
      };
    });

    await expect(runTurn("turn-suppressed")).resolves.toMatchObject({
      status: "suppressed",
      correlationPersisted: false,
    });
  });
});
