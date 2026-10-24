import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
} from "../config/sessions/conversation-delivery-store.js";
import * as deliveryStore from "../config/sessions/conversation-delivery-store.js";
import {
  registerConversationAddresses,
  prepareConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import * as conversationRegistry from "../config/sessions/conversation-registry.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../infra/outbound/delivery-queue.test-helpers.js";
import * as messageActionRunner from "../infra/outbound/message-action-runner.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
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
import {
  captureOutcome,
  reassignedConfig,
  releaseAndDrain,
  sentResult,
} from "./conversation-send-turn.test-support.js";
import { runGatewayConversationSend } from "./conversation-send.js";

const currentConversation = {
  ...conversation,
  channel: "reef-current",
  conversationRef: "conv_ffffffffffffffffffffffffffffffff",
};

async function createDeps() {
  const store = await createConversationDeliveryTestStore();
  return {
    ...store,
    readState: (id: string) => readConversationDeliveryStateForTest(store.scope, id),
    get: (id: string) => deliveryStore.getConversationDeliveryOperation(store.scope, id),
    send: (
      operationId: string,
      overrides: Partial<Parameters<typeof runGatewayConversationSend>[0]> = {},
    ) =>
      runGatewayConversationSend({
        config: store.config,
        agentId: "main",
        senderIsOwner: true,
        operationId,
        conversationRef: conversation.conversationRef,
        message: "hello",
        ...overrides,
      }),
    begin: (
      operationId: string,
      overrides: Partial<Parameters<typeof beginConversationDeliveryOperation>[1]> = {},
    ) =>
      beginConversationDeliveryOperation(store.scope, {
        operationId,
        operationKind: "send",
        conversationRef: conversation.conversationRef,
        message: "hello",
        ...overrides,
      }),
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

describe("conversation send through an accepted channel response", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it("reports the same unknown outcome initially and on replay when an accepted response lacks identity", async () => {
    const { clickClackPlugin } = await loadBundledPluginFacade<{ clickClackPlugin: ChannelPlugin }>(
      {
        pluginId: "clickclack",
        artifactBasename: "channel-plugin-api.ts",
      },
    );
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const config = {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          workspace: "wsp_synthetic",
          token: "synthetic-token",
        },
      },
    };
    const address = {
      channel: "clickclack",
      accountId: "default",
      kind: "channel" as const,
      peerId: "chn_synthetic",
    };
    const conversationRef = buildConversationRef(address);
    const scope = await prepareConversationRegistryScope({ agentId: "main", config });
    onTestFinished(async () => {
      await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    });
    await registerConversationAddresses(scope, [
      { ...address, conversationRef, deliveryTarget: "channel:chn_synthetic" },
    ]);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "clickclack", source: "test", plugin: clickClackPlugin }]),
    );
    const message = "accepted channel message";
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected transport retry"))
      .mockResolvedValueOnce(Response.json({ message: { body: message } }, { status: 201 }));
    const input = {
      config,
      agentId: "main",
      senderIsOwner: true,
      operationId: "accepted-without-identity",
      conversationRef,
      message,
    };

    const initial = await runGatewayConversationSend(input);
    const persisted = await deliveryStore.getConversationDeliveryOperation(
      scope,
      input.operationId,
    );
    const replay = await runGatewayConversationSend(input);

    expect(transport.mock.calls).toMatchObject([
      ["https://clickclack.example/api/channels/chn_synthetic/messages", { method: "POST" }],
    ]);
    expect(persisted).toMatchObject({ status: "unknown", queueId: initial.queueId });
    expect(await loadPendingDeliveries(stateDir)).toMatchObject([
      { recoveryState: "unknown_after_send" },
    ]);
    expect([initial.status, replay.status]).toEqual(["unknown", "unknown"]);
  });
});

describe("runGatewayConversationSend", () => {
  let deps: Awaited<ReturnType<typeof createDeps>>;
  beforeEach(async () => {
    deps = await createDeps();
  });

  it.each([false, true])(
    "admits the initial writable lookup before sending (aborted=%s)",
    async (aborted) => {
      const scope = await prepareConversationRegistryScope({
        agentId: "main",
        config: deps.config,
      });
      const writer = holdConversationWriterForTest(scope);
      await writer.entered;
      const controller = new AbortController();
      const reason = new Error("conversation cancelled while waiting");
      const sent = deps.send("send-admitted-lookup", {
        signal: controller.signal,
      });
      const outcome = captureOutcome(sent);
      try {
        await setImmediate();
        expect(deps.readState("send-admitted-lookup")).toBeUndefined();
        expect(deps.runMessageAction).not.toHaveBeenCalled();
        if (aborted) {
          controller.abort(reason);
        }
        await writer.release();
        if (aborted) {
          expect(await outcome).toEqual({ error: reason });
          expect(deps.readState("send-admitted-lookup")).toBeUndefined();
          expect(deps.runMessageAction).not.toHaveBeenCalled();
        } else {
          expect(await outcome).toMatchObject({ value: { status: "sent" } });
        }
      } finally {
        await releaseAndDrain(writer.release, outcome);
      }
    },
  );

  it("joins accepted send reconciliation on its original store after cancellation and config rotation", async () => {
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
    const settled = vi.fn();
    const sent = deps
      .send("send-settlement", {
        readCurrentConfig: () => currentConfig,
        signal: controller.signal,
      })
      .finally(settled);
    const outcome = captureOutcome(sent);
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
      expect(settled).not.toHaveBeenCalled();
      expect(deps.readState("send-settlement")?.status).toBe("queued");
      await writer.release();
      expect(await outcome).toMatchObject({
        value: { status: "sent", messageId: "reef-outbound-1" },
      });
      expect(await deps.get("send-settlement")).toMatchObject({ status: "sent" });
      expect(await replacement.getOperation(replacement.scope, "send-settlement")).toBeUndefined();
      expect(deps.runMessageAction).toHaveBeenCalledOnce();
    } finally {
      const writer = await writerReady;
      await releaseAndDrain(async () => {
        await writer?.release();
      }, outcome);
    }
  });

  it.each([
    { status: "unknown", preparedMessageId: "prepared" },
    { status: "rejected", preparedMessageId: undefined },
  ] as const)(
    "replays $status with persisted metadata and no current store access",
    async ({ status, preparedMessageId }) => {
      const operationId = "send-completed";
      await deps.begin(operationId, { preparedMessageId });
      await markConversationDeliveryQueued(deps.scope, operationId, "queue-existing");
      if (status === "unknown") {
        await markConversationDeliveryUnknown(deps.scope, operationId);
      } else {
        await markConversationDeliveryRejected(deps.scope, operationId, "permanent rejection");
      }
      deps.resolveConversation.mockResolvedValue(currentConversation);
      const currentConfig = {
        session: {
          get store(): string {
            throw new Error("current store must not be opened");
          },
        },
      };
      const result = deps.send(operationId, {
        readCurrentConfig: () => currentConfig,
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
    await deps.begin("send-unfinished");
    await registerConversationAddresses(deps.scope, [
      { ...currentConversation, deliveryTarget: currentConversation.target },
    ]);
    deps.resolveConversation.mockResolvedValue(currentConversation);
    await expect(deps.send("send-unfinished")).resolves.toMatchObject({
      status: "sent",
      channel: currentConversation.channel,
      conversationRef: currentConversation.conversationRef,
    });
    expect(deps.runMessageAction).toHaveBeenCalledOnce();
  });

  it("owns durable delivery in the Gateway and binds the source session", async () => {
    const result = await deps.send("send-1", {
      sourceSessionKey: "agent:main:telegram:direct:operator",
      message: "hello molty",
    });

    expect(await deps.get("send-1")).toMatchObject({
      operationId: "send-1",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      sourceSessionKey: "agent:main:telegram:direct:operator",
      status: "sent",
    });
    expect(deps.runMessageAction.mock.calls[0]?.[0]).toMatchObject({
      defaultAccountId: conversation.accountId,
      gatewayOwnedDelivery: true,
      forceCoreDelivery: true,
      requireQueuePersistence: true,
      sessionKey: "agent:main:telegram:direct:operator",
    });
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
    await deps.begin("send-reassigned");
    await markConversationDeliverySent(deps.scope, "send-reassigned", "reef-private-message");

    await expect(
      deps.send("send-reassigned", {
        config: reassignedConfig(deps.config),
      }),
    ).rejects.toBeInstanceOf(ConversationInputError);
  });

  it("revalidates a route-owner change at the durable delivery attempt", async () => {
    deps.runMessageAction.mockImplementation(async (input) => {
      await queueConversationDeliveryForTest(input, "queue-revoked-route");
      readCurrentConfig.mockReturnValue(reassignedConfig(deps.config));
      await input.withDirectAdapterHandoff?.(async () => undefined);
      return sentResult();
    });
    const readCurrentConfig = vi.fn().mockReturnValue(deps.config);

    await expect(
      deps.send("send-revoked-route", {
        readCurrentConfig,
      }),
    ).resolves.toMatchObject({ status: "queued", queueId: "queue-revoked-route" });

    expect(await deps.get("send-revoked-route")).toMatchObject({
      status: "queued",
      queueId: "queue-revoked-route",
    });
  });

  it("maps unknown conversations to terminal input errors", async () => {
    deps.resolveConversation.mockResolvedValueOnce(undefined);

    await expect(deps.send("send-missing")).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.readState("send-missing")).toBeUndefined();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("preserves durable operation conflicts for Gateway identity recovery", async () => {
    await deps.begin("send-reused", { message: "original" });
    await markConversationDeliverySent(deps.scope, "send-reused");
    deps.resolveConversation.mockResolvedValue(undefined);

    await expect(
      deps.send("send-reused", {
        message: "different",
      }),
    ).rejects.toBeInstanceOf(ConversationOperationConflictError);
    expect(deps.resolveConversation.mock.calls.length).toBe(0);
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });
});
