import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, onTestFinished, test, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.ts";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { collectSessionRowFrames } from "./session-row-delta-sockets.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";

let harness: GatewayServerHarness;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
    } finally {
      capture.mockRestore();
    }
  },
  cleanup: async () => harness?.close(),
});

test("unsubscribe acknowledgements and subscription switches preserve connection row baselines", async () => {
  const capable = await harness.openClient({
    caps: ["session-scoped-events", "session-row-deltas"],
  });
  const legacy = await harness.openClient({ caps: ["session-scoped-events"] });
  const keyA = "agent:main:row-delta-unsubscribe-a";
  const keyB = "agent:main:row-delta-unsubscribe-b";
  for (const key of [keyA, keyB]) {
    expect(
      (await rpcReq(capable.ws, "sessions.create", { key, agentId: "main", visibility: "shared" }))
        .ok,
    ).toBe(true);
  }
  const projection = getSessionRowProjection(kernel.gatewayRequestContext);
  if (!projection) {
    throw new Error("Expected runtime session projection");
  }
  await flushPendingSessionsChangedEvents(kernel.gatewayRequestContext);
  await drainSessionEventPublications(projection);
  for (const { ws } of [capable, legacy]) {
    expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    expect((await rpcReq(ws, "sessions.messages.subscribe", { key: keyA })).ok).toBe(true);
  }
  const encoded = collectSessionRowFrames(capable.ws);
  const baseline = collectSessionRowFrames(legacy.ws);
  const decoded: EventFrame[] = [];
  const reconnect = vi.fn();
  const decoder = new GatewayChatEvents(reconnect);
  capable.ws.on("message", (data) => {
    const event = JSON.parse(rawDataToString(data)) as EventFrame;
    if (event.type === "event" && event.event === "sessions.changed") {
      decoder.dispatch(event, (frame) => decoded.push(frame));
    }
  });
  const client = createTestGatewayClient(async (method, params) => {
    const response = await rpcReq(capable.ws, method, params);
    if (!response.ok || response.payload == null) {
      throw new Error(`Expected successful ${method} response`);
    }
    return response.payload;
  });
  const targets = await Promise.all(
    [keyA, keyB].map(async (key) => ({
      key,
      agentId: "main",
      storePath: (await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" })).storePath,
    })),
  );
  const publish = async (key: string) => {
    const target = targets.find((row) => row.key === key);
    if (!target) {
      throw new Error("Expected publication target");
    }
    await broadcastSessionActivitySummary(target, {
      getSessionRowProjection: () => projection,
      broadcast: kernel.gatewayRequestContext.broadcast,
    });
  };
  const drain = async () => {
    for (const { ws } of [capable, legacy]) {
      expect((await rpcReq(ws, "sessions.list", { agentId: "main", rowMode: "sidebar" })).ok).toBe(
        true,
      );
    }
  };
  const expectPair = () => {
    expect(reconnect).not.toHaveBeenCalled();
    expect(decoded.at(-1)?.payload).toEqual(baseline.at(-1)?.payload);
    expect(decoded).toHaveLength(encoded.length);
  };
  await publish(keyA);
  await publish(keyB);
  await drain();
  expectPair();

  const unsubscribe = sessionSubscriptionHandlers["sessions.messages.unsubscribe"];
  if (!unsubscribe) {
    throw new Error("Expected unsubscribe handler");
  }
  const interleave = vi
    .spyOn(sessionSubscriptionHandlers, "sessions.messages.unsubscribe")
    .mockImplementationOnce(async (options) => {
      let response: Parameters<typeof options.respond> | undefined;
      await unsubscribe({ ...options, respond: (...args) => (response = args) });
      if (!response) {
        throw new Error("Expected unsubscribe acknowledgement");
      }
      // The real mutation has finished; this frame must reach ingress before its ACK.
      await publish(keyB);
      options.respond(...response);
    });
  onTestFinished(() => interleave.mockRestore());
  await decoder.request(client, "sessions.messages.unsubscribe", { key: keyA });
  await drain();
  expectPair();
  await publish(keyB);
  await drain();
  expect(encoded.at(-1)?.payload).toHaveProperty("session.base");
  expectPair();

  expect((await rpcReq(legacy.ws, "sessions.messages.unsubscribe", { key: keyA })).ok).toBe(true);
  for (const key of [keyB, keyA, keyB]) {
    for (const { ws } of [capable, legacy]) {
      expect((await rpcReq(ws, "sessions.messages.subscribe", { key })).ok).toBe(true);
    }
    await publish(key);
    await drain();
    expect(encoded.at(-1)?.payload).toHaveProperty("session.base");
    expectPair();
    await decoder.request(client, "sessions.messages.unsubscribe", { key });
    expect((await rpcReq(legacy.ws, "sessions.messages.unsubscribe", { key })).ok).toBe(true);
  }
});
