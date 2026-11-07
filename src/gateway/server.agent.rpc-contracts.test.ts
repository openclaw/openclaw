import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
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
let kernel: Awaited<ReturnType<typeof captureGatewayKernel>>;

beforeAll(async () => {
  kernel = await captureGatewayKernel(async () => {
    harness = await startGatewayServerHarness();
  });
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

test("records the operator client's capabilities for later wakes of its session", async () => {
  const sessionKey = "agent:main:cli-caps";
  const cli = await harness.openClient({
    client: { id: "cli", version: "1.0.0", platform: "test", mode: "cli" },
    caps: ["tool-events", "no-question-input"],
  });
  // The later callers declare no caps; recording theirs would change the session's tool list.
  const backend = await harness.openClient();
  const turn = (ws: WebSocket, key: string, fields: Record<string, unknown> = {}) =>
    rpcReq(ws, "agent", { sessionKey, message: "hi", idempotencyKey: key, ...fields });
  try {
    expect((await turn(cli.ws, "cli-caps-operator")).ok).toBe(true);
    const wake = await turn(backend.ws, "cli-caps-wake", {
      inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
    });
    expect(wake.ok).toBe(true);
    // A plugin's in-process turn, without provenance, runs under a synthetic client.
    const context = kernel.gatewayRequestContext;
    await withPluginRuntimeGatewayRequestScope(
      {
        client: createSyntheticPluginRuntimeClient(),
        context,
        resolveGatewayContext: () => context,
        isWebchatConnect: () => false,
      },
      () =>
        dispatchGatewayMethodInProcess("agent", {
          sessionKey,
          message: "hi",
          idempotencyKey: "cli-caps-plugin",
        }),
    );
    const { entry } = await loadSessionEntryAsync(sessionKey, { agentId: "main" });
    expect(entry?.clientCapabilities).toEqual(["no-question-input", "tool-events"]);
  } finally {
    await closeGatewayTestWebSocket(cli.ws);
    await closeGatewayTestWebSocket(backend.ws);
  }
});
