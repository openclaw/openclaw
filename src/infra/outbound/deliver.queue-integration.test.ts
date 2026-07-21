import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createDefaultDeps, createOutboundSendDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../../plugin-sdk/plugin-state-test-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginHookRegistration } from "../../plugins/types.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  enqueueDelivery,
  loadPendingDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
import { drainPendingDeliveries, type DeliverFn } from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { attachMessageSentHookEvents } from "./message-sent-hook.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

type MatrixSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveMatrixSender(
  deps: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]["deps"],
): MatrixSendFn {
  const sender = deps?.matrix;
  if (typeof sender !== "function") {
    throw new Error("missing matrix sender");
  }
  return sender as MatrixSendFn;
}

function withMatrixChannel(result: Awaited<ReturnType<MatrixSendFn>>) {
  return {
    channel: "matrix" as const,
    ...result,
  };
}

const matrixOutboundForQueueTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId, deps }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
      }),
    ),
};

async function drainMatrixReconnect(opts: { deliver: DeliverFn; stateDir: string }): Promise<void> {
  await drainPendingDeliveries({
    drainKey: "matrix:reconnect-test",
    logLabel: "Matrix reconnect drain",
    cfg: {} as OpenClawConfig,
    log: createRecoveryLog(),
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
  });
}

function createPartialSendFailure() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1" })
    .mockRejectedValueOnce(new Error("second payload send failed"));
}

async function deliverPartialMatrixBatch(sendMatrix: ReturnType<typeof vi.fn>, tmpDir: string) {
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  await expect(
    deliverOutboundPayloads({
      cfg: {} as OpenClawConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }, { text: "second" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    }),
  ).rejects.toThrow("second payload send failed");
}

describe("deliverOutboundPayloads queue integration: mid-batch failure with send evidence", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    resetPluginStateStoreForTests();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    resetGlobalHookRunner();
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("preserves durable media queue identity through the CLI runtime into provider plugin state", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const planStore = createPluginStateKeyedStoreForTests<{
      queueId: string;
      queueStateDir?: string;
      payloadIndex: number;
      partIndex: number;
    }>("matrix", {
      namespace: "outbound-delivery-plans-cli-boundary",
      maxEntries: 10,
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
    });
    const matrixOutbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendText: async () => {
        throw new Error("expected durable media send");
      },
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        accountId,
        deps,
        deliveryQueueId,
        deliveryQueueStateDir,
        deliveryPayloadIndex,
        deliveryPartIndex,
        onPlatformSendDispatch,
        onDeliveryResult,
      }) => {
        if (deps) {
          expect(deliveryQueueId).toEqual(expect.any(String));
          expect(deliveryQueueStateDir).toBe(tmpDir);
          expect(deliveryPayloadIndex).toBe(0);
          expect(deliveryPartIndex).toBe(0);
          return withMatrixChannel(
            await resolveMatrixSender(deps)(to, text, {
              cfg,
              mediaUrl,
              accountId: accountId ?? undefined,
              deliveryQueueId,
              ...(deliveryQueueStateDir !== undefined ? { deliveryQueueStateDir } : {}),
              deliveryPayloadIndex,
              deliveryPartIndex,
              onPlatformSendDispatch,
              onDeliveryResult,
            }),
          );
        }
        if (
          deliveryQueueId === undefined ||
          deliveryPayloadIndex === undefined ||
          deliveryPartIndex === undefined
        ) {
          throw new Error("Matrix durable delivery requires stable payload and part indexes");
        }
        await planStore.registerIfAbsent(
          `${deliveryQueueId}.${deliveryPayloadIndex}.${deliveryPartIndex}`,
          {
            queueId: deliveryQueueId,
            ...(deliveryQueueStateDir !== undefined
              ? { queueStateDir: deliveryQueueStateDir }
              : {}),
            payloadIndex: deliveryPayloadIndex,
            partIndex: deliveryPartIndex,
          },
        );
        await onPlatformSendDispatch?.();
        const result = { channel: "matrix" as const, messageId: "matrix-cli-boundary-1" };
        await onDeliveryResult?.(result);
        return result;
      },
    };
    const matrixPlugin = {
      ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutbound }),
      message: {
        send: {
          text: async () => {
            throw new Error("expected durable media send");
          },
        },
        durableFinal: {
          replaySafeDeliveryId: true,
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: matrixPlugin,
        },
      ]),
    );
    const queueId = await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "required",
        payloads: [
          {
            text: "durable",
            mediaUrl: "https://example.invalid/durable.png",
          },
        ],
      },
      tmpDir,
    );
    const deps = createOutboundSendDeps(createDefaultDeps());
    const onDeliveryResult = vi.fn();
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps,
        onDeliveryResult,
      }),
    );

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending, pending[0]?.lastError).toHaveLength(0);
    await expect(planStore.lookup(`${queueId}.0.0`)).resolves.toEqual({
      queueId,
      queueStateDir: tmpDir,
      payloadIndex: 0,
      partIndex: 0,
    });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "matrix", messageId: "matrix-cli-boundary-1" }),
    );
  });

  it("advances queued entry to unknown_after_send when a later payload fails after an earlier one succeeded", async () => {
    let sendCount = 0;
    let stateBeforeSecondSend: string | undefined;
    const sendMatrix = vi.fn(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        return { messageId: "m1" };
      }
      stateBeforeSecondSend = (await loadPendingDeliveries(tmpDir))[0]?.recoveryState;
      throw new Error("second payload send failed");
    });

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);

    expect(stateBeforeSecondSend).toBe("unknown_after_send");
    const entries = await loadPendingDeliveries(tmpDir);
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "entries[0] test invariant");
    expect(entry.recoveryState).toBe("unknown_after_send");
    expect(entry.messageSentProviderAttemptedPayloadIndexes).toEqual([0, 1]);
    expect(entry.messageSentHookEvents).toEqual([
      {
        payloadIndex: 0,
        event: { success: true, content: "first", messageId: "m1" },
      },
    ]);
    expect(entry.retryCount).toBe(1);
    expect(entry.lastError).toContain("second payload send failed");
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("records every dispatched payload in an exact-reconciliation batch", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    let sendCount = 0;
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      sendCount += 1;
      await ctx.onPlatformSendDispatch?.();
      if (sendCount === 1) {
        return {
          messageId: "m1",
          receipt: { platformMessageIds: ["m1"], parts: [], sentAt: 1 },
        };
      }
      throw new Error("second payload response lost after dispatch");
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: { text: true, batch: true, reconcileUnknownSend: true },
                replaySafeDeliveryId: true,
                durableDeliveryProtocol: "test-matrix-plan-v1",
                reconcileUnknownSendKinds: { text: true, batch: true },
                reconcileUnknownSend: async () => ({ status: "replay_safe" as const }),
              },
              send: { text: messageSendText },
            },
          },
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      }),
    ).rejects.toThrow("second payload response lost after dispatch");

    const entries = await loadPendingDeliveries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.messageSentProviderAttemptedPayloadIndexes).toEqual([0, 1]);
    expect(entries[0]?.messageSentHookEvents).toEqual([
      {
        payloadIndex: 0,
        event: { success: true, content: "first", messageId: "m1" },
      },
    ]);
  });

  it("retains only the earlier payload attempt when a later payload is proven not dispatched", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1" })
      .mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("second payload stopped before dispatch", {
          cause: new Error("provider rejected before dispatch"),
        }),
      );

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        bestEffort: true,
      }),
    ).resolves.toHaveLength(1);

    const entries = await loadPendingDeliveries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.messageSentProviderAttemptedPayloadIndexes).toEqual([0]);
    expect(entries[0]?.messageSentHookEvents).toEqual([
      {
        payloadIndex: 0,
        event: { success: true, content: "first", messageId: "m1" },
      },
    ]);
  });

  it("drain preserves known payload success when the remaining batch cannot be reconciled", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const sendMatrix = createPartialSendFailure();

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);
    expect(auditEvents).toEqual([]);

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.map((event) => event.sourceId)).toEqual([
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:0`,
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:1`,
    ]);
    expect(beforeDrain[0]?.payloads).toHaveLength(2);
    expect(auditEvents.map((event) => event.outcome)).toEqual(["sent", "unknown"]);
    expect(auditEvents.map((event) => event.resultCount)).toEqual([1, 0]);
  });

  it("does not retain a pre-send suppression across an ambiguous crash boundary", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("ambiguous provider failure"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "NO_REPLY" }, { text: "visible" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ambiguous provider failure");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBe("send_attempt_started");
    expect(beforeDrain[0]?.payloads).toHaveLength(1);

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(auditEvents.map((event) => event.outcome)).toEqual(["unknown"]);
    expect(auditEvents.map((event) => event.resultCount)).toEqual([0]);
  });

  it("retains retryable send-attempt state when an adapter fails before returning a result", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("first payload send failed");

    const entries = await import("./delivery-queue-storage.js").then((m) =>
      m.loadPendingDeliveries(tmpDir),
    );
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "entries[0] test invariant");
    expect(entry.retryCount).toBe(1);
    expect(entry.recoveryState).toBe("send_attempt_started");
    expect(entry.lastError).toContain("first payload send failed");
  });

  it("replays an entry after a proven pre-connect failure clears send evidence", async () => {
    const messageSent = vi.fn(async () => undefined);
    const hookRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      },
    ]);
    addTestHook({
      registry: hookRegistry,
      pluginId: "observer",
      hookName: "message_sent",
      handler: messageSent as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);
    setActivePluginRegistry(hookRegistry);
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const connectError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(connectError);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(messageSent).not.toHaveBeenCalled();

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]).toMatchObject({
      retryCount: 1,
      lastError: expect.stringContaining("ECONNREFUSED"),
    });
    expect(beforeDrain[0]?.recoveryState).toBeUndefined();
    expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();
    expect(beforeDrain[0]?.messageSentProviderAttemptedPayloadIndexes).toBeUndefined();

    const recoverySendMatrix = vi
      .fn()
      .mockRejectedValueOnce(connectError)
      .mockResolvedValueOnce({ messageId: "recovered" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: recoverySendMatrix },
      }),
    );
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
    const afterRepeatedFailure = await loadPendingDeliveries(tmpDir);
    expect(afterRepeatedFailure).toHaveLength(1);
    expect(afterRepeatedFailure[0]?.retryCount).toBe(2);
    expect(afterRepeatedFailure[0]?.recoveryState).toBeUndefined();
    expect(afterRepeatedFailure[0]?.platformSendStartedAt).toBeUndefined();
    expect(messageSent).not.toHaveBeenCalled();

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(recoverySendMatrix).toHaveBeenCalledTimes(2);
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(messageSent).toHaveBeenCalledTimes(1);
    expect(messageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "first",
        messageId: "recovered",
        success: true,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("replays an entry after the provider proves no platform message was dispatched", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "upload timed out before completion dispatch",
      { cause: new Error("request timed out") },
    );
    const sendMatrix = vi.fn().mockRejectedValueOnce(notDispatchedError);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("upload timed out before completion dispatch");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBeUndefined();
    expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();

    const recoverySendMatrix = vi.fn().mockResolvedValueOnce({ messageId: "recovered" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: recoverySendMatrix },
      }),
    );
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledOnce();
    expect(recoverySendMatrix).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });

  it("does not republish message_sent for legacy rows that emitted per attempt", async () => {
    const messageSent = vi.fn(async () => undefined);
    const hookRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      },
    ]);
    addTestHook({
      registry: hookRegistry,
      pluginId: "observer",
      hookName: "message_sent",
      handler: messageSent as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);
    setActivePluginRegistry(hookRegistry);

    await enqueueDelivery(
      { channel: "matrix", to: "!room:legacy", payloads: [{ text: "legacy" }] },
      tmpDir,
    );
    const deliver = vi.fn<DeliverFn>(async () => [
      { channel: "matrix", messageId: "legacy-recovered" },
    ]);

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(messageSent).not.toHaveBeenCalled();
  });

  it("retains per-attempt message_sent behavior when a legacy row is recovered", async () => {
    const messageSent = vi.fn(async () => undefined);
    const hookRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      },
    ]);
    addTestHook({
      registry: hookRegistry,
      pluginId: "observer",
      hookName: "message_sent",
      handler: messageSent as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);
    setActivePluginRegistry(hookRegistry);
    await enqueueDelivery(
      { channel: "matrix", to: "!room:legacy", payloads: [{ text: "legacy" }] },
      tmpDir,
    );
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: vi.fn().mockResolvedValue({ messageId: "legacy-recovered" }) },
      }),
    );

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(messageSent).toHaveBeenCalledTimes(1);
    expect(messageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "legacy",
        messageId: "legacy-recovered",
        success: true,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("publishes persisted success when a later payload dead-letters", async () => {
    const messageSent = vi.fn(async () => undefined);
    const hookRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      },
    ]);
    addTestHook({
      registry: hookRegistry,
      pluginId: "observer",
      hookName: "message_sent",
      handler: messageSent as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);
    setActivePluginRegistry(hookRegistry);
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { mediaUrl: "https://example.com/file.png" }],
        deps: { matrix: vi.fn().mockResolvedValue({ messageId: "first-id" }) },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("does not implement sendMedia");
    expect(messageSent).not.toHaveBeenCalled();

    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending[0]?.messageSentProviderAttemptedPayloadIndexes).toEqual([0]);
    expect(pending[0]?.messageSentHookEvents).toEqual([
      {
        payloadIndex: 0,
        event: { success: true, content: "first", messageId: "first-id" },
      },
    ]);
    await drainMatrixReconnect({ deliver: vi.fn<DeliverFn>(), stateDir: tmpDir });

    expect(messageSent).toHaveBeenCalledTimes(1);
    expect(messageSent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "first", messageId: "first-id", success: true }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("keeps sparse persisted success terminal when a replay-safe retry fails", async () => {
    const messageSent = vi.fn(async () => undefined);
    const reconcileUnknownSend = vi.fn(() => ({ status: "replay_safe" as const }));
    const matrixPlugin = {
      ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      message: {
        send: {
          text: async () => ({
            messageId: "unused",
            receipt: { platformMessageIds: ["unused"], parts: [], sentAt: 1 },
          }),
        },
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend,
        },
      },
    };
    const hookRegistry = createTestRegistry([
      { pluginId: "matrix", source: "test", plugin: matrixPlugin },
    ]);
    addTestHook({
      registry: hookRegistry,
      pluginId: "observer",
      hookName: "message_sent",
      handler: messageSent as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);
    setActivePluginRegistry(hookRegistry);
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "second" }],
        preparedHookPayloadIndexes: [0],
        payloadSourceIndexes: [1],
        messageSentHookMode: "logical_terminal",
        messageSentHookEvents: [
          {
            payloadIndex: 1,
            event: { success: true, content: "second", messageId: "event-1" },
          },
        ],
      },
      tmpDir,
    );
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir, { payloadIndex: 1 });
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir);
    const deliver = vi.fn<DeliverFn>(async (params) => {
      expect(params.payloadSourceIndexes).toEqual([1]);
      const error = new Error("chat not found");
      params.onPayloadDeliveryOutcome?.({
        index: 1,
        status: "failed",
        error,
        sentBeforeError: false,
        stage: "platform_send",
      });
      throw attachMessageSentHookEvents(error, [
        {
          payloadIndex: 1,
          event: { success: false, content: "second", error: "chat not found" },
        },
      ]);
    });

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(reconcileUnknownSend).toHaveBeenCalledWith(
      expect.objectContaining({ payloadSourceIndexes: [1] }),
    );
    expect(messageSent).toHaveBeenCalledTimes(1);
    expect(messageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "second",
        messageId: "event-1",
        success: true,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:1`,
      outcome: "sent",
      resultCount: 1,
    });
  });
});
