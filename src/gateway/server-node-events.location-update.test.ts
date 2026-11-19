// Stage 1/2 boundary proof for the `location.update` node event.
//
// Pins the consumer contract: a valid event with no subscribed plugin is
// validated and dropped (`no_consumer`, unhandled, zero side effects); the
// plugin-registered consumer receives the typed payload exactly once;
// malformed payloads are rejected before any consumer runs; a throwing
// consumer never breaks gateway handling; and registry retirement (plugin
// reload/rollback) removes subscriptions with the generation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  clearActivePluginRegistry,
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const { buildNodeEventContext: buildCtx, runtimeMocks } =
  await import("./server-node-events.test-support.js");
const {
  enqueueSystemEventEntry: enqueue,
  enqueueSessionEventForHost: handoff,
  agentCommandFromGatewayIngress: dispatch,
  upsertSessionEntryCore: touchSession,
} = runtimeMocks;

function nodeEvent(event: string, payload: unknown): NodeEvent {
  return { event, payloadJSON: JSON.stringify(payload) };
}

const validLocationUpdate = {
  lat: 57.6973,
  lon: 11.9508,
  accuracyMeters: 18,
  source: "ios-significant-location",
};

/** Activates an empty registry for the no-consumer cases. */
function activateEmptyRegistryForTest(): PluginRegistry {
  const snapshot = captureActivePluginRegistrySnapshot();
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  cleanupRegistrySnapshots.push(snapshot);
  return registry;
}

const cleanupRegistrySnapshots: ReturnType<typeof captureActivePluginRegistrySnapshot>[] = [];

function activateConsumerRegistryForTest(handle: () => void): void {
  const snapshot = captureActivePluginRegistrySnapshot();
  const registry = createEmptyPluginRegistry();
  registry.nodeEventConsumers.push({
    pluginId: "location-intents-test",
    source: "test",
    subscription: { events: ["location.update"], handle },
  });
  setActivePluginRegistry(registry);
  cleanupRegistrySnapshots.push(snapshot);
}

describe("location.update node event (gateway consumer boundary)", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    enqueue.mockReset();
    handoff.mockClear();
    dispatch.mockClear();
    touchSession.mockClear();
  });

  afterEach(async () => {
    while (cleanupRegistrySnapshots.length > 0) {
      const snapshot = cleanupRegistrySnapshots.pop();
      if (snapshot) {
        restoreActivePluginRegistrySnapshot(snapshot);
      }
    }
    await clearActivePluginRegistry(null);
    resetGatewayWorkAdmission();
  });

  function makeCtx(overrides: Partial<NodeEventContext> = {}): NodeEventContext {
    return buildCtx({ broadcast: vi.fn(), ...overrides }) as unknown as NodeEventContext;
  }

  it("valid event with no subscribed plugin: validated drop with zero side effects", async () => {
    activateEmptyRegistryForTest();
    const broadcast = vi.fn();
    const ctx = makeCtx({ broadcast });
    const result = await handleNodeEvent(
      ctx,
      "iphone-node",
      nodeEvent("location.update", validLocationUpdate),
    );
    expect(result).toEqual({
      ok: true,
      event: "location.update",
      handled: false,
      reason: "no_consumer",
    });
    expect(broadcast).not.toHaveBeenCalled();
    expectNoCalls(enqueue, handoff, dispatch, touchSession);
  });

  it("subscribed plugin consumer receives the typed payload exactly once, no broadcast or wake", async () => {
    const consumer = vi.fn();
    activateConsumerRegistryForTest(consumer);
    const broadcast = vi.fn();
    const ctx = makeCtx({ broadcast });
    const result = await handleNodeEvent(
      ctx,
      "iphone-node",
      nodeEvent("location.update", validLocationUpdate),
    );
    expect(result).toEqual({
      ok: true,
      event: "location.update",
      handled: true,
      reason: "dispatched",
    });
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith({
      nodeId: "iphone-node",
      payload: validLocationUpdate,
    });
    expect(broadcast).not.toHaveBeenCalled();
    expectNoCalls(enqueue, handoff, dispatch, touchSession);
  });

  it("throwing consumers are isolated: gateway handling still succeeds", async () => {
    activateConsumerRegistryForTest(() => {
      throw new Error("consumer boom");
    });
    const logGateway = { warn: vi.fn() };
    const ctx = makeCtx({ broadcast: vi.fn(), logGateway });
    const result = await handleNodeEvent(
      ctx,
      "iphone-node",
      nodeEvent("location.update", validLocationUpdate),
    );
    expect(result).toEqual({
      ok: true,
      event: "location.update",
      handled: true,
      reason: "dispatched",
    });
    expect(logGateway.warn).toHaveBeenCalledTimes(2);
    for (const call of logGateway.warn.mock.calls) {
      expect(String(call[0])).not.toContain("57.6973");
    }
  });

  it("retired registry generation stops dispatch: subscriptions go with the registry", async () => {
    const consumer = vi.fn();
    activateConsumerRegistryForTest(consumer);
    // Simulate plugin reload retirement: restore the prior (empty) registry.
    const snapshot = cleanupRegistrySnapshots.pop();
    if (snapshot) {
      restoreActivePluginRegistrySnapshot(snapshot);
    }
    const ctx = makeCtx({ broadcast: vi.fn() });
    const result = await handleNodeEvent(
      ctx,
      "iphone-node",
      nodeEvent("location.update", validLocationUpdate),
    );
    expect(result).toEqual({
      ok: true,
      event: "location.update",
      handled: false,
      reason: "no_consumer",
    });
    expect(consumer).not.toHaveBeenCalled();
  });

  it("malformed payloads are rejected without any consumer call", async () => {
    const consumer = vi.fn();
    activateConsumerRegistryForTest(consumer);
    const ctx = makeCtx({ broadcast: vi.fn() });
    for (const payloadJSON of [
      "not-json",
      JSON.stringify([57.7, 11.95]),
      JSON.stringify({ lat: "57.7", lon: 11.95, accuracyMeters: 18 }),
      JSON.stringify({ lat: 57.7, lon: 11.95, accuracyMeters: -1 }),
      JSON.stringify({ lat: 96, lon: 11.95, accuracyMeters: 18 }),
      JSON.stringify({ lat: 57.7, lon: 200, accuracyMeters: 18 }),
      JSON.stringify({ lon: 11.95, accuracyMeters: 18, source: "x" }),
      JSON.stringify({ lat: 57.7, lon: 11.95, accuracyMeters: 18, extra: true }),
      null,
      undefined,
    ]) {
      const result = await handleNodeEvent(ctx, "iphone-node", {
        event: "location.update",
        payloadJSON,
      });
      expect(result).toEqual({
        ok: true,
        event: "location.update",
        handled: false,
        reason: "invalid_payload",
      });
    }
    expect(consumer).not.toHaveBeenCalled();
    expectNoCalls(enqueue, handoff, dispatch, touchSession);
  });

  it("isolates async consumer rejections: dispatch succeeds and the failure is logged", async () => {
    // Regression for the review finding: an async consumer assignable to
    // the declared void return rejected, the promise was discarded, and the
    // rejection reached the process-level handler (which exits the
    // Gateway). The dispatcher must observe the returned promise, log the
    // failure, and still ack the event.
    const rejection = new Error("consumer failed asynchronously");
    const asyncConsumer = vi.fn(() => Promise.reject(rejection));
    activateConsumerRegistryForTest(asyncConsumer);
    const logGateway = { warn: vi.fn() };
    const ctx = makeCtx({ broadcast: vi.fn(), logGateway });
    const result = await handleNodeEvent(
      ctx,
      "iphone-node",
      nodeEvent("location.update", validLocationUpdate),
    );
    // Dispatch succeeds: the event was handled and acked.
    expect(result).toEqual({
      ok: true,
      event: "location.update",
      handled: true,
      reason: "dispatched",
    });
    expect(asyncConsumer).toHaveBeenCalledTimes(1);
    // The rejection was observed and logged, not leaked: flush the
    // microtask queue before asserting the warn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logGateway.warn).toHaveBeenCalledWith(
      "node event consumer failed node=iphone-node event=location.update: consumer failed asynchronously",
    );
  });
});
