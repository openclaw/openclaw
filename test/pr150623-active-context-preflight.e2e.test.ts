import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { anthropicTextTurn } from "./anthropic-text-turn.test-support.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const MODEL_REF = "preflight-proof/preflight-proof";
const SESSION_KEY = "agent:main:active-context-preflight";
const SUPERSEDED_MARKER = "SUPERSEDED_HISTORY_MARKER";
const SUMMARY_MARKER = "ACTIVE_SUMMARY_MARKER";
const REPLY_MARKER = "ACTIVE_CONTEXT_REPLY_COMPLETED";

const instances: OpenClawTestInstance[] = [];
const modelServers: Awaited<ReturnType<typeof startMockModelServer>>[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

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

    const sessionId = randomUUID();
    const storePath = path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite");
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: SESSION_KEY,
      storePath,
      env: instance.state.env,
    };
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    });
    const transcript = await SessionManager.openAsync(scope, instance.state.workspaceDir);
    const appendUser = (content: string, timestamp: number) =>
      transcript.appendMessageAsync({ role: "user", content, timestamp });
    await appendUser(`${SUPERSEDED_MARKER} `.repeat(25_000), 1);
    const retained = await appendUser("retain", 2);
    assert(retained, "Seeded transcript message was not appended");
    await transcript.appendCompactionAsync(SUMMARY_MARKER, retained, 100_000);
    await appendUser("active tail", 3);

    await instance.startGateway();
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
    await instance.stopGateway();
    expect(
      (await SessionManager.openAsync(scope, instance.state.workspaceDir))
        .getEntries()
        .filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
  },
);

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

async function startMockModelServer() {
  const requests: Array<{ body: unknown }> = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  return {
    baseUrl: await listenLoopback(server),
    requests,
    close: () => closeHttpServer(server),
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
  requests.push({ body: JSON.parse(await readRequestText(request)) });
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.end(anthropicTextTurn("preflight-proof", REPLY_MARKER, "msg_preflight_proof", 20, 4));
}
