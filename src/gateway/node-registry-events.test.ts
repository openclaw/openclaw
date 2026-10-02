import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { setActiveNodeContexts } from "../infra/active-node-context.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import {
  createTestNodeSocket,
  makeClient,
  registerNodeSession,
  registerSocket,
} from "./node-registry.test-helpers.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const registries = new Set<NodeRegistry>();
const pairingA = { pairingIdentity: "identity-a", pairingGeneration: "generation-a" };

function createNodeRegistry(options?: ConstructorParameters<typeof NodeRegistry>[0]): NodeRegistry {
  const registry = new NodeRegistry(options);
  registries.add(registry);
  return registry;
}

afterEach(() => {
  for (const registry of registries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  registries.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setActiveNodeContexts([]);
});

describe("NodeRegistry event delivery", () => {
  it.for(["identity", "generation"] as const)(
    "delivers the %s event before a queued metadata observation",
    async (binding, { signal }) => {
      const readEntered = createDeferred();
      const releaseRead = createDeferred();
      const observationEntered = createDeferred();
      const releaseObservation = createDeferred();
      const releaseGates = () => {
        releaseRead.resolve();
        releaseObservation.resolve();
      };
      signal.addEventListener("abort", releaseGates, { once: true });
      let observing = false;
      const registry = createNodeRegistry({
        resolveCurrentPairingState: () =>
          withDevicePairingLock(async () => {
            readEntered.resolve();
            await withinTest(releaseRead.promise, signal);
            return { identity: "identity-a", generation: "generation-a" };
          }),
        isPairingStateCurrent: () => {
          if (observing) {
            throw new Error("pairing observation is pending");
          }
          return true;
        },
      });
      const frames: string[] = [];
      registerNodeSession(registry, makeClient("conn-1", "node-1", frames), pairingA);
      const event = binding === "identity" ? "voicewake.changed" : "voicewake.routing.changed";
      const payload = { revision: 1 };
      const send =
        binding === "identity"
          ? registry.sendEventForPairingIdentity({
              nodeId: "node-1",
              connId: "conn-1",
              pairingIdentity: "identity-a",
              event,
              payload,
            })
          : registry.sendEventRawForPairingGeneration(
              "node-1",
              "generation-a",
              event,
              serializeEventPayload(payload),
            );
      let observation: Promise<void> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            readEntered.promise,
            send,
            "event send settled before the held pairing read",
          ),
          signal,
        );
        // Queue outside the read's async context so this is the next writer,
        // not a reentrant borrow of the read's current admission.
        observation = withDevicePairingLock(async () => {
          observing = true;
          observationEntered.resolve();
          try {
            await withinTest(releaseObservation.promise, signal);
          } finally {
            observing = false;
          }
        });
        releaseRead.resolve();
        await withinTest(observationEntered.promise, signal);
        expect(await withinTest(send, signal)).toBe(true);
        expect(frames.map((frame) => JSON.parse(frame))).toEqual([
          { type: "event", event, payload },
        ]);
      } finally {
        releaseGates();
        signal.removeEventListener("abort", releaseGates);
        await withinTest(Promise.allSettled([send, observation]), signal);
      }
    },
  );

  it("sends raw event payload JSON without changing the envelope shape", () => {
    const registry = createNodeRegistry();
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {});
    const payload = serializeEventPayload({ foo: "bar" });
    const nullPayload = serializeEventPayload(null);
    const falsePayload = serializeEventPayload(false);
    const zeroPayload = serializeEventPayload(0);
    const emptyStringPayload = serializeEventPayload("");

    expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "nullish", nullPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "flag", falsePayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "count", zeroPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "empty", emptyStringPayload)).toBe(true);
    expect(registry.sendEventRaw("missing-node", "chat", payload)).toBe(false);
    expect(registry.sendEventRaw("node-1", "heartbeat", null)).toBe(true);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        "not-json" as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        '{"x":1},"seq":999' as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);

    expect(frames).toEqual([
      '{"type":"event","event":"chat","payload":{"foo":"bar"}}',
      '{"type":"event","event":"nullish","payload":null}',
      '{"type":"event","event":"flag","payload":false}',
      '{"type":"event","event":"count","payload":0}',
      '{"type":"event","event":"empty","payload":""}',
      '{"type":"event","event":"heartbeat"}',
    ]);
  });

  it("rate-limits failed event delivery warnings for registered nodes", async () => {
    const capture = createDiagnosticLogRecordCapture();
    setLoggerOverride({
      level: "warn",
      consoleLevel: "silent",
      file: path.join(resolvePreferredOpenClawTmpDir(), `node-event-send-${process.pid}.log`),
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registry = createNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      socket: createTestNodeSocket([], WebSocket.CLOSING) as unknown as GatewayWsClient["socket"],
    });
    registerNodeSession(registry, client, {});

    try {
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);
      expect(registry.sendEventRaw("node-1", "raw.failed", null)).toBe(false);

      now.mockReturnValue(31_001);
      expect(registry.sendEventRaw("node-1", "raw.failed", null)).toBe(false);
      now.mockReturnValue(61_002);
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);

      client.invalidated = true;
      expect(registry.sendEvent("node-1", "invalidated.failed", {})).toBe(false);
      expect(registry.unregister("conn-1")).toBe("node-1");
      expect(registry.sendEvent("node-1", "unregistered.failed", {})).toBe(false);
      await capture.flush();

      const warnings = capture.records.filter(
        (record) => record.message === "node event delivery failed",
      );
      expect(warnings.map((record) => record.attributes)).toEqual([
        expect.objectContaining({ nodeId: "node-1", event: "normal.failed" }),
        expect.objectContaining({ nodeId: "node-1", event: "raw.failed" }),
        expect.objectContaining({ nodeId: "node-1", event: "normal.failed" }),
      ]);
    } finally {
      capture.cleanup();
      setLoggerOverride(null);
      resetLogger();
      now.mockRestore();
    }
  });

  it("drops a delayed voice-wake snapshot after persistent generation changes", async () => {
    const { promise: currentPairingState, resolve: resolveCurrent } = createDeferred<
      { identity: string; generation?: string } | undefined
    >();
    const resolveCurrentPairingState = vi.fn(() => currentPairingState);
    const registry = createNodeRegistry({ resolveCurrentPairingState });
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), pairingA);

    const send = registry.sendEventRawForPairingGeneration(
      "node-1",
      "generation-a",
      "voicewake.changed",
      serializeEventPayload({ triggers: ["openclaw"] }),
    );
    await vi.waitFor(() => expect(resolveCurrentPairingState).toHaveBeenCalledTimes(1));
    resolveCurrent({ identity: "identity-a", generation: "generation-b" });

    await expect(send).resolves.toBe(false);
    expect(frames).toEqual([]);
  });

  it("drops a delayed command-free snapshot after pairing identity deletion", async () => {
    const { promise: currentPairingState, resolve: resolveCurrent } = createDeferred<
      { identity: string } | undefined
    >();
    const registry = createNodeRegistry({
      resolveCurrentPairingState: async () => await currentPairingState,
    });
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {
      pairingIdentity: "identity-a",
    });

    const send = registry.sendEventForPairingIdentity({
      nodeId: "node-1",
      connId: "conn-1",
      pairingIdentity: "identity-a",
      event: "voicewake.changed",
      payload: { triggers: ["openclaw"] },
    });
    resolveCurrent(undefined);

    await expect(send).resolves.toBe(false);
    expect(frames).toEqual([]);
    await expect(registry.listCurrentConnected()).resolves.toEqual([]);
  });

  it("does not retarget an approval refresh when its connection changes during pairing verification", async () => {
    const { promise: currentPairingState, resolve: resolveCurrent } = createDeferred<{
      identity: string;
      generation: string;
    }>();
    const registry = createNodeRegistry({
      resolveCurrentPairingState: async () => await currentPairingState,
    });
    const previousFrames: string[] = [];
    const replacementFrames: string[] = [];
    const pairing = pairingA;
    registerNodeSession(registry, makeClient("conn-1", "node-1", previousFrames), pairing);
    const send = registry.sendEventForPairingIdentity({
      nodeId: "node-1",
      connId: "conn-1",
      pairingIdentity: "identity-a",
      event: "node.pair.resolved",
      payload: { nodeId: "node-1", decision: "approved", requestId: "approval-1", ts: 1 },
    });
    registerNodeSession(registry, makeClient("conn-2", "node-1", replacementFrames), pairing);
    resolveCurrent({ identity: "identity-a", generation: "generation-a" });

    await expect(send).resolves.toBe(false);
    expect(previousFrames).toEqual([]);
    expect(replacementFrames).toEqual([]);
  });

  it("rejects raw event sends when the node socket buffer is saturated", () => {
    vi.useFakeTimers();
    resetDiagnosticEventsForTest();
    const diagnosticEvents: unknown[] = [];
    const stopDiagnostics = onDiagnosticEvent((event) => diagnosticEvents.push(event));
    const registry = createNodeRegistry();
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    registerSocket(registry, socket);
    const payload = serializeEventPayload({ foo: "bar" });

    try {
      expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
      expect(socket.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
      expect(socket.terminate).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
      expect(socket.terminate).toHaveBeenCalledOnce();
      expect(socket.close.mock.invocationCallOrder[0]).toBeLessThan(
        socket.terminate.mock.invocationCallOrder[0]!,
      );
      expect(diagnosticEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "payload.large",
            action: "rejected",
            surface: "gateway.ws.outbound_buffer",
            bytes: MAX_BUFFERED_BYTES + 1,
            limitBytes: MAX_BUFFERED_BYTES,
            reason: "ws_send_buffer_close",
          }),
        ]),
      );
    } finally {
      stopDiagnostics();
      resetDiagnosticEventsForTest();
    }
  });

  it("cancels node slow-consumer termination after the socket closes", () => {
    vi.useFakeTimers();
    const registry = createNodeRegistry();
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    registerSocket(registry, socket);

    expect(registry.sendEventRaw("node-1", "chat", serializeEventPayload({ foo: "bar" }))).toBe(
      false,
    );
    socket.emit("close", 1008, Buffer.from("slow consumer"));
    vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);

    expect(socket.terminate).not.toHaveBeenCalled();
  });
});
