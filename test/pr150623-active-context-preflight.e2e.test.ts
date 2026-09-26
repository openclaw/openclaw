import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const MODEL_REF = "preflight-proof/preflight-proof";
const SESSION_KEY = "agent:main:active-context-preflight";
const SUPERSEDED_MARKER = "SUPERSEDED_HISTORY_MARKER";
const SUMMARY_MARKER = "ACTIVE_SUMMARY_MARKER";
const REPLY_MARKER = "ACTIVE_CONTEXT_REPLY_COMPLETED";

type MockModelServer = {
  baseUrl: string;
  requests: Array<{ body: unknown }>;
  close: () => Promise<void>;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("active-context preflight compaction", () => {
  it(
    "completes the next real runtime turn without compacting superseded history",
    { timeout: 180_000 },
    async () => {
      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "active-context-preflight",
        config: createTestConfig(modelServer.baseUrl),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);
      await instance.startGateway();

      const sessionId = randomUUID();
      const storePath = path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite");
      const scope = { agentId: "main", sessionId, sessionKey: SESSION_KEY, storePath };
      await upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
        totalTokensFresh: false,
      });
      const transcript = SessionManager.open(scope, instance.state.workspaceDir);
      transcript.appendMessage({
        role: "user",
        content: `${SUPERSEDED_MARKER} `.repeat(25_000),
        timestamp: 1,
      });
      const retained = transcript.appendMessage({ role: "user", content: "retain", timestamp: 2 });
      transcript.appendCompaction(SUMMARY_MARKER, retained, 100_000);
      transcript.appendMessage({ role: "user", content: "active tail", timestamp: 3 });

      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        const runId = randomUUID();
        const result = await client.request<{ runId?: string; status?: string }>(
          "agent",
          {
            sessionKey: SESSION_KEY,
            message: "continue after compaction",
            deliver: false,
            idempotencyKey: runId,
          },
          { expectFinal: true, timeoutMs: 120_000 },
        );
        expect(result).toMatchObject({ runId, status: "ok" });
        expect(modelServer.requests).toHaveLength(1);
        const requestBody = JSON.stringify(modelServer.requests[0]?.body);
        expect(requestBody).toContain(SUMMARY_MARKER);
        expect(requestBody).toContain("active tail");
        expect(requestBody).toContain("continue after compaction");
        expect(requestBody).not.toContain(SUPERSEDED_MARKER);

        const history = await client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 20,
        });
        expect(JSON.stringify(history.messages ?? [])).toContain(REPLY_MARKER);
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        "preflight-proof": {
          baseUrl,
          apiKey: "test-token-placeholder",
          api: "anthropic-messages",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "preflight-proof",
              name: "preflight-proof",
              api: "anthropic-messages",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: Array<{ body: unknown }> = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("preflight proof model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{ body: unknown }>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/v1/messages") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.end(
    [
      {
        type: "message_start",
        message: {
          id: "msg_preflight_proof",
          type: "message",
          role: "assistant",
          model: "preflight-proof",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: REPLY_MARKER },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
}
