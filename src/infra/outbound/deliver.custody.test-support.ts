import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

export function createDeliveryBarrier() {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    entered: entered.promise,
    hold: async () => {
      entered.resolve();
      await released.promise;
    },
    release: released.resolve,
    wait: (operation: Promise<unknown>) =>
      awaitGateBeforeSettlement(entered.promise, operation, "Operation settled before the barrier"),
  };
}

export function useDeliveryCleanup(after?: () => void) {
  const release: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];
  const unsubscribe: Array<() => void> = [];
  afterEach(async () => {
    for (const dispose of release.splice(0).toReversed()) {
      dispose();
    }
    await Promise.allSettled(pending.splice(0));
    unsubscribe.splice(0).forEach((dispose) => dispose());
    after?.();
  });
  const audit = (terminalOnly = false) => {
    const outcomes: string[] = [];
    unsubscribe.push(
      onTrustedMessageAuditEvent((event) => {
        if (!terminalOnly || event.action === "message.outbound.finished") {
          outcomes.push(event.outcome);
        }
      }),
    );
    return outcomes;
  };
  return { release, pending, unsubscribe, audit };
}

export function useOutboundRuntime() {
  let runtime: typeof import("./deliver.js");
  let queue: typeof import("./deliver-queue.js");
  beforeAll(async () => {
    [runtime, queue] = await Promise.all([import("./deliver.js"), import("./deliver-queue.js")]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });
  return {
    deliver: (params: Parameters<typeof runtime.deliverOutboundPayloads>[0]) =>
      runtime.deliverOutboundPayloads(params),
    internal: (params: Parameters<typeof runtime.deliverOutboundPayloadsInternal>[0]) =>
      runtime.deliverOutboundPayloadsInternal(params),
    structured: (params: Parameters<typeof runtime.deliverStructuredOutboundPayloadsInternal>[0]) =>
      runtime.deliverStructuredOutboundPayloadsInternal(params),
    run: (params: Parameters<typeof queue.runOutboundDeliveryInternal>[0]) =>
      queue.runOutboundDeliveryInternal(params),
  };
}

export function useOutboundFixture() {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const runtime = useOutboundRuntime();
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir()));
  return { ...runtime, tmpDir };
}

export function matrixDeliveryResult(messageId: string, kind: "text" | "media" = "text") {
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId }],
      kind,
    }),
  };
}

export function installQueueTestPlugin(overrides: Partial<ChannelPlugin> = {}) {
  const plugin = {
    ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
    ...overrides,
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
}
