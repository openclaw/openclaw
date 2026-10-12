import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
  type ConversationDeliveryRecord,
} from "../config/sessions/conversation-delivery-store.js";
import * as deliveryStore from "../config/sessions/conversation-delivery-store.js";
import {
  registerConversationAddresses,
  prepareConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import * as conversationRegistry from "../config/sessions/conversation-registry.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import * as messageActionRunner from "../infra/outbound/message-action-runner.js";
import {
  conversation,
  createConversationDeliveryTestStore,
  holdConversationWriterForTest,
  queueConversationDeliveryForTest,
  readConversationDeliveryStateForTest,
} from "./conversation-delivery.test-support.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";
import { runGatewayConversationSend } from "./conversation-send.js";

function sentResult() {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: conversation.target,
    handledBy: "core",
    payload: {},
    sendResult: {
      channel: "reef",
      to: conversation.target,
      via: "direct",
      mediaUrl: null,
      result: { messageId: "reef-outbound-1" },
      deliveryStatus: "sent",
    },
    dryRun: false,
  } satisfies Extract<MessageActionResult, { kind: "send" }>;
}

async function createDeps(agentId = "main") {
  const store = await createConversationDeliveryTestStore(agentId);
  return {
    ...store,
    beginOperation: vi.spyOn(deliveryStore, "beginConversationDeliveryOperation"),
    getOperation: vi.spyOn(deliveryStore, "getConversationDeliveryOperation"),
    markSent: vi.spyOn(deliveryStore, "markConversationDeliverySent"),
    markSuppressed: vi.spyOn(deliveryStore, "markConversationDeliverySuppressed"),
    resolveConversation: vi
      .spyOn(conversationRegistry, "readConversation")
      .mockResolvedValue(conversation),
    runMessageAction: vi
      .spyOn(messageActionRunner, "runMessageAction")
      .mockImplementation(async (input) => {
        await queueConversationDeliveryForTest(input);
        return sentResult();
      }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("runGatewayConversationSend", () => {
  it.each([false, true])(
    "admits the initial writable lookup before sending (aborted=%s)",
    async (aborted) => {
      const deps = await createDeps();
      const scope = await prepareConversationRegistryScope({
        agentId: "main",
        config: deps.config,
      });
      const writer = holdConversationWriterForTest(scope);
      await writer.entered;
      const controller = new AbortController();
      const reason = new Error("conversation cancelled while waiting");
      const sent = runGatewayConversationSend({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        operationId: "send-admitted-lookup",
        conversationRef: conversation.conversationRef,
        message: "hello",
        signal: controller.signal,
      });
      const outcome = sent.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await setImmediate();
        expect(
          readConversationDeliveryStateForTest(deps.scope, "send-admitted-lookup"),
        ).toBeUndefined();
        expect(deps.runMessageAction).not.toHaveBeenCalled();
        if (aborted) {
          controller.abort(reason);
        }
        await writer.release();
        if (aborted) {
          expect(await outcome).toEqual({ error: reason });
          expect(
            readConversationDeliveryStateForTest(deps.scope, "send-admitted-lookup"),
          ).toBeUndefined();
          expect(deps.runMessageAction).not.toHaveBeenCalled();
        } else {
          expect(await outcome).toMatchObject({ value: { status: "sent" } });
        }
      } finally {
        try {
          await writer.release();
        } finally {
          await outcome;
        }
      }
    },
  );

  it("joins accepted send reconciliation on its original store after cancellation and config rotation", async () => {
    const deps = await createDeps();
    const replacement = await createConversationDeliveryTestStore();
    const scope = await prepareConversationRegistryScope({ agentId: "main", config: deps.config });
    const blocked = createDeferred<ReturnType<typeof holdConversationWriterForTest>>();
    const controller = new AbortController();
    let currentConfig = deps.config;
    deps.runMessageAction.mockImplementation(async (input) => {
      await queueConversationDeliveryForTest(input);
      expect(input.deliveryCompletion).toMatchObject({
        kind: "conversation",
        agentId: "main",
        operationId: "send-settlement",
        routeFingerprint: expect.any(String),
      });
      const writer = holdConversationWriterForTest(scope);
      blocked.resolve(writer);
      return sentResult();
    });
    let settled = false;
    const sent = runGatewayConversationSend({
      config: deps.config,
      readCurrentConfig: () => currentConfig,
      agentId: "main",
      senderIsOwner: true,
      operationId: "send-settlement",
      conversationRef: conversation.conversationRef,
      message: "hello",
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    const outcome = sent.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const writerReady = Promise.race([blocked.promise, outcome.then(() => undefined)]);
    try {
      const writer = await writerReady;
      if (!writer) {
        throw new Error("Conversation send settled before reaching its reconciliation writer", {
          cause: await outcome,
        });
      }
      await writer.entered;
      controller.abort(new Error("cancelled after recipient evidence"));
      currentConfig = replacement.config;
      await setImmediate();
      expect(settled).toBe(false);
      expect(readConversationDeliveryStateForTest(deps.scope, "send-settlement")?.status).toBe(
        "queued",
      );
      await writer.release();
      expect(await outcome).toMatchObject({
        value: { status: "sent", messageId: "reef-outbound-1" },
      });
      expect(await deps.getOperation(deps.scope, "send-settlement")).toMatchObject({
        status: "sent",
      });
      expect(await replacement.getOperation(replacement.scope, "send-settlement")).toBeUndefined();
      expect(deps.runMessageAction).toHaveBeenCalledOnce();
    } finally {
      const writer = await writerReady;
      try {
        await writer?.release();
      } finally {
        await outcome;
      }
    }
  });

  it.each([
    { status: "unknown", preparedMessageId: "prepared" },
    { status: "rejected" },
  ] satisfies Array<{
    status: ConversationDeliveryRecord["status"];
    preparedMessageId?: string;
  }>)(
    "replays $status with persisted metadata and no current store access",
    async ({ status, preparedMessageId }) => {
      const deps = await createDeps();
      const operationId = "send-completed";
      await beginConversationDeliveryOperation(deps.scope, {
        operationId,
        operationKind: "send",
        conversationRef: conversation.conversationRef,
        message: "hello",
        preparedMessageId,
      });
      await markConversationDeliveryQueued(deps.scope, operationId, "queue-existing");
      if (status === "unknown") {
        await markConversationDeliveryUnknown(deps.scope, operationId);
      } else {
        await markConversationDeliveryRejected(deps.scope, operationId, "permanent rejection");
      }
      deps.resolveConversation.mockResolvedValue({
        ...conversation,
        channel: "reef-current",
        conversationRef: "conv_ffffffffffffffffffffffffffffffff",
      });
      const result = runGatewayConversationSend({
        config: deps.config,
        readCurrentConfig: () => ({
          session: {
            get store(): string {
              throw new Error("current store must not be opened");
            },
          },
        }),
        agentId: "main",
        senderIsOwner: true,
        operationId,
        conversationRef: conversation.conversationRef,
        message: "hello",
      });
      if (status === "rejected") {
        await expect(result).rejects.toMatchObject({
          name: "ConversationInputError",
          message: "permanent rejection",
        });
      } else {
        await expect(result).resolves.toEqual({
          status,
          conversationRef: conversation.conversationRef,
          channel: conversation.channel,
          queueId: "queue-existing",
        });
      }
      expect(deps.resolveConversation).toHaveBeenCalled();
      expect(deps.runMessageAction).not.toHaveBeenCalled();
    },
  );

  it("projects current conversation metadata for an unfinished send", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "send-unfinished",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      message: "hello",
    });
    const current = {
      ...conversation,
      channel: "reef-current",
      conversationRef: "conv_ffffffffffffffffffffffffffffffff",
    };
    await registerConversationAddresses(deps.scope, [
      { ...current, deliveryTarget: current.target },
    ]);
    deps.resolveConversation.mockResolvedValue(current);
    await expect(
      runGatewayConversationSend({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        operationId: "send-unfinished",
        conversationRef: conversation.conversationRef,
        message: "hello",
      }),
    ).resolves.toMatchObject({
      status: "sent",
      channel: current.channel,
      conversationRef: current.conversationRef,
    });
    expect(deps.runMessageAction).toHaveBeenCalledOnce();
  });

  it("owns durable delivery in the Gateway and binds the source session", async () => {
    const deps = await createDeps();
    const result = await runGatewayConversationSend({
      config: deps.config,
      agentId: "main",
      senderIsOwner: true,
      sourceSessionKey: "agent:main:telegram:direct:operator",
      operationId: "send-1",
      conversationRef: conversation.conversationRef,
      message: "hello molty",
    });

    expect(await deps.getOperation(deps.scope, "send-1")).toMatchObject({
      operationId: "send-1",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      sourceSessionKey: "agent:main:telegram:direct:operator",
      status: "sent",
    });
    expect(deps.runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultAccountId: conversation.accountId,
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        suppressTranscriptMirror: true,
        sessionKey: "agent:main:telegram:direct:operator",
      }),
    );
    expect(deps.runMessageAction.mock.calls[0]?.[0]?.params).not.toHaveProperty("accountId");
    expect(result).toEqual({
      status: "sent",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
  });

  it("does not reveal completed send state after the route owner changes", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "send-reassigned",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      message: "hello",
    });
    await markConversationDeliverySent(deps.scope, "send-reassigned", "reef-private-message");

    await expect(
      runGatewayConversationSend({
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
        operationId: "send-reassigned",
        conversationRef: conversation.conversationRef,
        message: "hello",
      }),
    ).rejects.toBeInstanceOf(ConversationInputError);
  });

  it("revalidates a route-owner change at the durable delivery attempt", async () => {
    const deps = await createDeps();
    deps.runMessageAction.mockImplementation(async (input) => {
      await queueConversationDeliveryForTest(input, "queue-revoked-route");
      readCurrentConfig.mockReturnValue({
        ...deps.config,
        agents: { entries: { main: {}, finance: {} } },
        bindings: [
          { type: "route", agentId: "finance", match: { channel: "reef", accountId: "default" } },
        ],
      });
      await input.withDirectAdapterHandoff?.(async () => undefined);
      return sentResult();
    });
    const readCurrentConfig = vi.fn().mockReturnValue(deps.config);

    await expect(
      runGatewayConversationSend({
        config: deps.config,
        readCurrentConfig,
        agentId: "main",
        senderIsOwner: true,
        operationId: "send-revoked-route",
        conversationRef: conversation.conversationRef,
        message: "hello",
      }),
    ).resolves.toMatchObject({ status: "queued", queueId: "queue-revoked-route" });

    expect(await deps.getOperation(deps.scope, "send-revoked-route")).toMatchObject({
      status: "queued",
      queueId: "queue-revoked-route",
    });
  });

  it("maps unknown conversations to terminal input errors", async () => {
    const deps = await createDeps();
    deps.resolveConversation.mockResolvedValueOnce(undefined);

    await expect(
      runGatewayConversationSend({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        operationId: "send-missing",
        conversationRef: conversation.conversationRef,
        message: "hello",
      }),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(readConversationDeliveryStateForTest(deps.scope, "send-missing")).toBeUndefined();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("preserves durable operation conflicts for Gateway identity recovery", async () => {
    const deps = await createDeps();
    await beginConversationDeliveryOperation(deps.scope, {
      operationId: "send-reused",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      message: "original",
    });
    await markConversationDeliverySent(deps.scope, "send-reused");
    deps.resolveConversation.mockResolvedValue(undefined);

    await expect(
      runGatewayConversationSend({
        config: deps.config,
        agentId: "main",
        senderIsOwner: true,
        operationId: "send-reused",
        conversationRef: conversation.conversationRef,
        message: "different",
      }),
    ).rejects.toBeInstanceOf(ConversationOperationConflictError);
    expect(deps.resolveConversation.mock.calls.length).toBe(0);
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });
});
