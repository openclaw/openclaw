import { afterEach, beforeEach, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createEnteredGate } from "../../agents/entered-gate.test-support.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  runOutboundDelivery,
  runOutboundDeliveryInternal,
  runStructuredOutboundDeliveryInternal,
} from "./deliver-queue.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

export function createDeliveryBarrier() {
  const gate = createEnteredGate();
  return {
    entered: gate.entered,
    hold: gate.wait,
    release: gate.release,
    wait: (operation: Promise<unknown>) =>
      awaitGateBeforeSettlement(gate.entered, operation, "Operation settled before the barrier"),
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
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });
  return {
    deliver: runOutboundDelivery,
    internal: runOutboundDeliveryInternal,
    structured: runStructuredOutboundDeliveryInternal,
    run: runOutboundDeliveryInternal,
  };
}

export function useOutboundFixture() {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir()));
  return { ...useOutboundRuntime(), tmpDir };
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
