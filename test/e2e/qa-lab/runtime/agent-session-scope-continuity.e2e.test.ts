import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { createTrackedProvider } from "../../../../src/gateway/test-helpers.tracked-provider.js";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import { runCleanups, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectOperator,
  messageRole,
  messageText,
  startSessionGateway,
} from "./agent-session.test-support.js";
import { writeFixtureReply } from "./gateway-recovery.test-support.js";

const TEST_TIMEOUT_MS = 120_000;
const SESSION_A_KEY = "agent:qa:qa:session-scope-continuity-a";
const SESSION_B_KEY = "agent:qa:qa:session-scope-continuity-b";
const SESSION_A_USER_1 = "SESSION-SCOPE-A-USER-1";
const SESSION_A_ASSISTANT_1 = "SESSION-SCOPE-A-ASSISTANT-1";
const SESSION_A_USER_2 = "SESSION-SCOPE-A-USER-2";
const SESSION_A_ASSISTANT_2 = "SESSION-SCOPE-A-ASSISTANT-2";
const SESSION_B_USER_1 = "SESSION-SCOPE-B-USER-1";
const SESSION_B_ASSISTANT_1 = "SESSION-SCOPE-B-ASSISTANT-1";
const MARKERS = [
  SESSION_A_USER_1,
  SESSION_A_ASSISTANT_1,
  SESSION_A_USER_2,
  SESSION_A_ASSISTANT_2,
  SESSION_B_USER_1,
  SESSION_B_ASSISTANT_1,
] as const;

type AgentResult = {
  runId?: string;
  status?: string;
};
type ChatHistory = {
  sessionId?: string;
  messages?: unknown[];
};
type CanonicalTurn = {
  role: "user" | "assistant";
  marker: (typeof MARKERS)[number];
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(() => runCleanups(cleanups, "agent-session-scope-continuity cleanup failed"));

async function startDeterministicProvider() {
  const requests: Array<Record<string, unknown>> = [];
  const replies = [SESSION_A_ASSISTANT_1, SESSION_A_ASSISTANT_2, SESSION_B_ASSISTANT_1];
  const server = createTrackedProvider((raw, response, request) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      respondJson(response, { data: [{ id: "gpt-5.6-luna", object: "model" }] });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    const reply = replies[requests.length - 1];
    if (!reply) {
      response.writeHead(500).end("unexpected provider call");
      return;
    }
    writeFixtureReply(
      response,
      reply,
      `qa-session-scope-message-${requests.length}`,
      `qa-session-scope-response-${requests.length}`,
    );
  });
  return {
    baseUrl: (await server.listen()).replace(/\/v1$/, ""),
    requests,
    stop: () => server.close(),
  };
}

function markerTurns(messages: unknown[]): CanonicalTurn[] {
  return messages.flatMap((message) => {
    const role = messageRole(message);
    if (role !== "user" && role !== "assistant") {
      return [];
    }
    const text = messageText(message);
    const markers = MARKERS.filter((marker) => text.includes(marker));
    if (markers.length > 0) {
      expect(markers).toHaveLength(1);
    }
    return markers.map((marker) => ({ role, marker }));
  });
}

function providerMarkerTurns(request: Record<string, unknown>): CanonicalTurn[] {
  return markerTurns(Array.isArray(request.input) ? request.input : []);
}

async function runAgentTurn(
  client: GatewayClient,
  sessionKey: string,
  message: string,
  runId: string,
): Promise<void> {
  const accepted = await client.request<AgentResult>("agent", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(accepted).toMatchObject({ status: "accepted", runId });
  const terminal = await client.request<AgentResult>(
    "agent.wait",
    { runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(terminal).toMatchObject({ status: "ok", runId });
}

it(
  "reuses one session across fresh turns without leaking history into another key",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const provider = await startDeterministicProvider();
    cleanups.push(() => provider.stop());
    const gatewayOwner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await startSessionGateway(gatewayOwner, provider.baseUrl, {
      useRepoCli: false,
    });
    const client = await connectOperator(gateway, "Session scope continuity client");
    cleanups.push(() => client.stopAndWait({ timeoutMs: 1_000 }));
    const readHistory = async (sessionKey: string) => {
      const history = await client.request<ChatHistory>("chat.history", {
        sessionKey,
        limit: 20,
      });
      expect(history.sessionId).toEqual(expect.any(String));
      return history;
    };

    await runAgentTurn(client, SESSION_A_KEY, SESSION_A_USER_1, "qa-session-scope-a-turn-1");
    const historyAAfterTurn1 = await readHistory(SESSION_A_KEY);

    await runAgentTurn(client, SESSION_A_KEY, SESSION_A_USER_2, "qa-session-scope-a-turn-2");
    const historyA = await readHistory(SESSION_A_KEY);
    expect(historyA.sessionId).toBe(historyAAfterTurn1.sessionId);
    expect(markerTurns(historyA.messages ?? [])).toEqual([
      { role: "user", marker: SESSION_A_USER_1 },
      { role: "assistant", marker: SESSION_A_ASSISTANT_1 },
      { role: "user", marker: SESSION_A_USER_2 },
      { role: "assistant", marker: SESSION_A_ASSISTANT_2 },
    ]);
    expect(providerMarkerTurns(provider.requests[1] ?? {})).toEqual([
      { role: "user", marker: SESSION_A_USER_1 },
      { role: "assistant", marker: SESSION_A_ASSISTANT_1 },
      { role: "user", marker: SESSION_A_USER_2 },
    ]);

    await runAgentTurn(client, SESSION_B_KEY, SESSION_B_USER_1, "qa-session-scope-b-turn-1");
    const historyB = await readHistory(SESSION_B_KEY);
    expect(historyB.sessionId).not.toBe(historyA.sessionId);
    expect(markerTurns(historyB.messages ?? [])).toEqual([
      { role: "user", marker: SESSION_B_USER_1 },
      { role: "assistant", marker: SESSION_B_ASSISTANT_1 },
    ]);
    expect(providerMarkerTurns(provider.requests[2] ?? {})).toEqual([
      { role: "user", marker: SESSION_B_USER_1 },
    ]);
    expect(JSON.stringify(provider.requests[2])).not.toContain("SESSION-SCOPE-A-");
    expect(provider.requests).toHaveLength(3);
  },
);
