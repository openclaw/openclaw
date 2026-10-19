import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
// Real Gateway WebSocket proof for session-only replies, response ordering, and idempotency.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { AgentCommandDeliveryResult } from "../agents/command/delivery-result.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type AgentResponse = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: {
    runId?: string;
    status?: string;
    result?: Pick<AgentCommandDeliveryResult, "payloads" | "deliveryStatus" | "deliverySucceeded">;
  };
};

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

beforeEach(async () => {
  vi.mocked(agentCommandMock).mockReset();
  await prepareGatewayReplyRuntimeForTest();
});

afterAll(async () => {
  await harness.close();
});

function sendAgentRequest(params: {
  ws: WebSocket;
  id: string;
  idempotencyKey: string;
  message: string;
}): void {
  params.ws.send(
    JSON.stringify({
      type: "req",
      id: params.id,
      method: "agent",
      params: {
        message: params.message,
        sessionKey: "main",
        deliver: true,
        bestEffortDeliver: true,
        idempotencyKey: params.idempotencyKey,
      },
    }),
  );
}

describe("gateway agent RPC contracts", () => {
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

    const idempotencyKey = "gateway-agent-rpc-contract";
    const clientOptions: Parameters<GatewayServerHarness["openClient"]>[0] = {
      browserOrigin: `http://127.0.0.1:${harness.port}`,
      client: { id: "webchat-ui", version: "1.0.0", platform: "test", mode: "webchat" },
    };
    const first = await harness.openClient(clientOptions);
    const orderedResponses: AgentResponse[] = [];
    const recordResponse = (data: RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as AgentResponse;
      if (frame.type === "res" && frame.id === "agent-contract") {
        orderedResponses.push(frame);
      }
    };
    first.ws.on("message", recordResponse);
    const acceptedPromise = onceMessage<AgentResponse>(
      first.ws,
      (frame) =>
        frame.type === "res" &&
        frame.id === "agent-contract" &&
        frame.payload?.status === "accepted",
    );
    const terminalPromise = onceMessage<AgentResponse>(
      first.ws,
      (frame) =>
        frame.type === "res" &&
        frame.id === "agent-contract" &&
        frame.payload?.status !== "accepted",
    );

    let terminal: AgentResponse;
    try {
      sendAgentRequest({
        ws: first.ws,
        id: "agent-contract",
        idempotencyKey,
        message: "prove the gateway agent RPC contract",
      });

      await acceptedPromise;
      await awaitGateBeforeSettlement(
        commandStarted.promise,
        terminalPromise,
        "agent completed before command dispatch",
      );
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(agentCommandMock).mock.calls[0]?.[0]).toMatchObject({
        runId: idempotencyKey,
        channel: "webchat",
        messageChannel: "webchat",
        runContext: { messageChannel: "webchat" },
        deliver: false,
        bestEffortDeliver: true,
      });

      runCompletion.resolve();
      terminal = await terminalPromise;
      expect(orderedResponses.map((frame) => frame.payload?.status)).toEqual(["accepted", "ok"]);
      expect(orderedResponses[0]).toMatchObject({
        type: "res",
        id: "agent-contract",
        ok: true,
        payload: {
          runId: idempotencyKey,
          status: "accepted",
        },
      });
      expect(terminal).toMatchObject({
        type: "res",
        id: "agent-contract",
        ok: true,
        payload: {
          runId: idempotencyKey,
          status: "ok",
          result: {
            payloads: [{ text: "assistant reply" }],
          },
        },
      });
      expect(terminal.payload?.result).not.toHaveProperty("deliveryStatus");
      expect(terminal.payload?.result).not.toHaveProperty("deliverySucceeded");
    } finally {
      runCompletion.resolve();
      first.ws.off("message", recordResponse);
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
      sendAgentRequest({
        ws: second.ws,
        id: "agent-contract-replay",
        idempotencyKey,
        message: "this duplicate must not execute",
      });

      const replay = await replayPromise;
      expect(replay.payload).toEqual(terminal.payload);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    } finally {
      await closeGatewayTestWebSocket(second.ws);
    }
  });
});
