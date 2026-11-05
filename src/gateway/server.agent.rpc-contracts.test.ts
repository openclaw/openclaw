import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const idempotencyKey = "gateway-agent-rpc-contract";
const payloads = [{ text: "assistant reply" }];
const agentParams = { sessionKey: "main", deliver: true, bestEffortDeliver: true, idempotencyKey };

type AgentResponse = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: { status?: string; result?: object };
};

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

beforeEach(() => prepareGatewayReplyRuntimeForTest());

afterAll(() => harness.close());

function sendAgentRequest(ws: WebSocket, id: string, message: string): void {
  const params = { ...agentParams, message };
  ws.send(JSON.stringify({ type: "req", id, method: "agent", params }));
}

test("preserves a session-only WebChat reply across ordered final response and replay", async () => {
  const commandStarted = createDeferred();
  const runCompletion = createDeferred();
  vi.mocked(agentCommandMock).mockImplementationOnce(async () => {
    commandStarted.resolve();
    await runCompletion.promise;
    return {
      payloads: [{ text: "assistant reply" }],
      meta: { durationMs: 1 },
    };
  });

  const clientOptions: Parameters<GatewayServerHarness["openClient"]>[0] = {
    browserOrigin: `http://127.0.0.1:${harness.port}`,
    client: { id: "webchat-ui", version: "1.0.0", platform: "test", mode: "webchat" },
  };
  const first = await harness.openClient(clientOptions);
  const orderedResponses: AgentResponse[] = [];
  const waitForResponse = (accepted: boolean) =>
    onceMessage<AgentResponse>(
      first.ws,
      (frame) =>
        frame.type === "res" &&
        frame.id === "agent-contract" &&
        (frame.payload?.status === "accepted") === accepted,
    ).then((frame) => {
      orderedResponses.push(frame);
      return frame;
    });
  const acceptedPromise = waitForResponse(true);
  const terminalPromise = waitForResponse(false);

  let terminal: AgentResponse;
  try {
    sendAgentRequest(first.ws, "agent-contract", "prove the gateway agent RPC contract");

    await acceptedPromise;
    await awaitGateBeforeSettlement(
      commandStarted.promise,
      terminalPromise,
      "agent completed before command dispatch",
    );
    expect(vi.mocked(agentCommandMock).mock.calls[0]?.[0]).toMatchObject({
      channel: "webchat",
      messageChannel: "webchat",
      runContext: { messageChannel: "webchat" },
      deliver: false,
      bestEffortDeliver: true,
    });

    runCompletion.resolve();
    terminal = await terminalPromise;
    expect(orderedResponses.map(({ ok, payload }) => ({ ok, payload }))).toMatchObject([
      { ok: true, payload: { runId: idempotencyKey, status: "accepted" } },
      { ok: true, payload: { runId: idempotencyKey, status: "ok", result: { payloads } } },
    ]);
    expect(terminal.payload?.result).not.toHaveProperty("deliveryStatus");
    expect(terminal.payload?.result).not.toHaveProperty("deliverySucceeded");
  } finally {
    runCompletion.resolve();
    const responsesSettled = Promise.allSettled([acceptedPromise, terminalPromise]);
    await closeGatewayTestWebSocket(first.ws);
    await responsesSettled;
  }

  const second = await harness.openClient(clientOptions);
  try {
    const replayPromise = onceMessage<AgentResponse>(
      second.ws,
      (frame) => frame.type === "res" && frame.id === "agent-contract-replay",
    );
    sendAgentRequest(second.ws, "agent-contract-replay", "this duplicate must not execute");

    const replay = await replayPromise;
    expect(replay.payload).toEqual(terminal.payload);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
  } finally {
    await closeGatewayTestWebSocket(second.ws);
  }
});
