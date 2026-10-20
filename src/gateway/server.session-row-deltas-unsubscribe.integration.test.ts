import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core";
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
    const capture = vi
      .spyOn(module, "createGatewayKernel")
      .mockImplementation(async (...args) => (kernel = await create(...args)));
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
  const sockets = [capable.ws, legacy.ws];
  const request = async (method: string, params: unknown, ws = capable.ws) => {
    const response = await rpcReq(ws, method, params);
    expect(response.ok).toBe(true);
    return response.payload;
  };
  const context = kernel.gatewayRequestContext;
  const keyA = "agent:main:row-delta-unsubscribe-a";
  const keyB = "agent:main:row-delta-unsubscribe-b";
  for (const key of [keyA, keyB]) {
    await request("sessions.create", { key, agentId: "main", visibility: "shared" });
  }
  const projection = expectDefined(getSessionRowProjection(context), "session projection");
  await flushPendingSessionsChangedEvents(context);
  await drainSessionEventPublications(projection);
  for (const ws of sockets) {
    await request("sessions.subscribe", {}, ws);
    await request("sessions.messages.subscribe", { key: keyA }, ws);
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
  const client = createTestGatewayClient(async (method, params) =>
    expectDefined(await request(method, params), `${method} payload`),
  );
  // Both sessions belong to the same main-agent store.
  const { storePath } = await loadGatewaySessionEntryReadOnlyAsync(keyA, { agentId: "main" });
  const publish = (key: string) =>
    broadcastSessionActivitySummary(
      { key, agentId: "main", storePath },
      { getSessionRowProjection: () => projection, broadcast: context.broadcast },
    );
  const expectPair = async (delta = false) => {
    for (const ws of sockets) {
      await request("sessions.list", { agentId: "main", rowMode: "sidebar" }, ws);
    }
    if (delta) {
      expect(encoded.at(-1)?.payload).toHaveProperty("session.base");
    }
    expect(reconnect).not.toHaveBeenCalled();
    expect(decoded.at(-1)?.payload).toEqual(baseline.at(-1)?.payload);
    expect(decoded).toHaveLength(encoded.length);
  };
  await publish(keyA);
  await publish(keyB);
  await expectPair();

  const unsubscribe = expectDefined(
    sessionSubscriptionHandlers["sessions.messages.unsubscribe"],
    "unsubscribe handler",
  );
  const interleave = vi
    .spyOn(sessionSubscriptionHandlers, "sessions.messages.unsubscribe")
    .mockImplementationOnce(async (options) => {
      let response: Parameters<typeof options.respond> | undefined;
      await unsubscribe({ ...options, respond: (...args) => (response = args) });
      const acknowledgement = expectDefined(response, "unsubscribe acknowledgement");
      // The real mutation has finished; this frame must reach ingress before its ACK.
      await publish(keyB);
      options.respond(...acknowledgement);
    });
  onTestFinished(() => interleave.mockRestore());
  await decoder.request(client, "sessions.messages.unsubscribe", { key: keyA });
  await expectPair();
  await publish(keyB);
  await expectPair(true);

  await request("sessions.messages.unsubscribe", { key: keyA }, legacy.ws);
  for (const key of [keyB, keyA, keyB]) {
    for (const ws of sockets) {
      await request("sessions.messages.subscribe", { key }, ws);
    }
    await publish(key);
    await expectPair(true);
    await decoder.request(client, "sessions.messages.unsubscribe", { key });
    await request("sessions.messages.unsubscribe", { key }, legacy.ws);
  }
});
