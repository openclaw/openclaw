import { createServer } from "node:http";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectOperator,
  messageRole,
  messageText,
  runCleanups,
  startSessionGateway,
} from "./agent-session.test-support.js";
import { listenLoopback, writeFixtureReply } from "./gateway-recovery.test-support.js";

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
  result?: {
    payloads?: Array<{ text?: string }>;
  };
};
type SessionRow = {
  key?: string;
  sessionId?: string;
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
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [{ id: "gpt-5.6-luna", object: "model" }],
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  const baseUrl = await listenLoopback(
    server,
    "deterministic provider did not bind a loopback port",
  );
  return {
    baseUrl,
    requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
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

async function runAgentTurn(params: {
  client: GatewayClient;
  sessionKey: string;
  userText: string;
  runId: string;
}): Promise<void> {
  const accepted = await params.client.request<AgentResult>("agent", {
    sessionKey: params.sessionKey,
    message: params.userText,
    deliver: false,
    idempotencyKey: params.runId,
  });
  expect(accepted).toMatchObject({
    status: "accepted",
    runId: params.runId,
  });
  const terminal = await params.client.request<AgentResult>(
    "agent.wait",
    { runId: params.runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(terminal).toMatchObject({
    status: "ok",
    runId: params.runId,
  });
}

async function readSession(client: GatewayClient, sessionKey: string): Promise<SessionRow> {
  const result = await client.request<{ sessions?: SessionRow[] }>("sessions.list", {
    agentId: "qa",
    includeGlobal: true,
    limit: 200,
  });
  const session = result.sessions?.find((candidate) => candidate.key === sessionKey);
  expect(session, `expected sessions.list row for ${sessionKey}`).toBeDefined();
  expect(session?.sessionId).toEqual(expect.any(String));
  return session ?? {};
}

async function readHistory(client: GatewayClient, sessionKey: string): Promise<ChatHistory> {
  return await client.request<ChatHistory>("chat.history", {
    sessionKey,
    limit: 20,
  });
}

describe("agent session scope continuity", () => {
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

      await runAgentTurn({
        client,
        sessionKey: SESSION_A_KEY,
        userText: SESSION_A_USER_1,
        runId: "qa-session-scope-a-turn-1",
      });
      const sessionAAfterTurn1 = await readSession(client, SESSION_A_KEY);

      await runAgentTurn({
        client,
        sessionKey: SESSION_A_KEY,
        userText: SESSION_A_USER_2,
        runId: "qa-session-scope-a-turn-2",
      });
      const sessionAAfterTurn2 = await readSession(client, SESSION_A_KEY);
      expect(sessionAAfterTurn2.sessionId).toBe(sessionAAfterTurn1.sessionId);

      const historyA = await readHistory(client, SESSION_A_KEY);
      expect(historyA.sessionId).toBe(sessionAAfterTurn1.sessionId);
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

      await runAgentTurn({
        client,
        sessionKey: SESSION_B_KEY,
        userText: SESSION_B_USER_1,
        runId: "qa-session-scope-b-turn-1",
      });
      const sessionB = await readSession(client, SESSION_B_KEY);
      expect(sessionB.sessionId).not.toBe(sessionAAfterTurn1.sessionId);

      const historyB = await readHistory(client, SESSION_B_KEY);
      expect(historyB.sessionId).toBe(sessionB.sessionId);
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
});
