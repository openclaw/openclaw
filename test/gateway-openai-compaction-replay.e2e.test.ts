import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
  type OpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const SESSION_KEY = "agent:main:compaction-replay";
const COMPACTION_ID = "cmp_gateway_replay";
const COMPACTION_DATA = "opaque-gateway-compaction";

type CapturedRequest = { input?: unknown[] };

const instances: OpenClawTestInstance[] = [];
const modelServers: OpenAiResponsesModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

it(
  "Gateway OpenAI Responses compaction replay replays persisted provider state on the next embedded turn",
  { timeout: 180_000 },
  async () => {
    const modelServer = await startMockModelServer();
    modelServers.push(modelServer);
    const instance = await createOpenClawTestInstance({
      name: "gateway-openai-compaction-replay",
      config: createOpenAiResponsesModelConfig({
        baseUrl: modelServer.baseUrl,
        providerId: "replay-proof",
        modelId: "replay-proof",
        reasoning: true,
        toolProfile: "minimal",
      }),
      env: {
        OPENCLAW_DEBUG_MODEL_TRANSPORT: "1",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    instances.push(instance);
    await instance.startGateway();

    const client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      await runAgentTurn(client, "capture compaction state");
      // The provider can terminate after emitting only a compaction item. The
      // runner must retain that checkpoint through another invisible retry.
      expect(modelServer.requests).toHaveLength(3);

      const session = await client.request<{
        sessions?: Array<{ key?: string; sessionId?: string }>;
      }>("sessions.list", { includeGlobal: true, limit: 20 });
      const sessionId = session.sessions?.find((row) => row.key === SESSION_KEY)?.sessionId;
      if (!sessionId) {
        throw new Error(`sessions.list omitted the durable id for ${SESSION_KEY}`);
      }
      const manager = SessionManager.open({
        agentId: "main",
        sessionId,
        sessionKey: SESSION_KEY,
        storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
      });
      const persistedReplay = manager
        .buildSessionContext()
        .messages.find((message) => message.role === "assistant")?.providerReplay;
      expect(persistedReplay).toMatchObject({
        v: 1,
        type: "openai-responses-compaction",
        id: COMPACTION_ID,
        data: COMPACTION_DATA,
        provider: "replay-proof",
        api: "openai-responses",
        model: "replay-proof",
        baseUrlHash: expect.any(String),
        sessionHash: expect.any(String),
      });
      expect(persistedReplay).not.toHaveProperty("authProfileHash");
      const continuationJson = expectCompactionReplay(modelServer.requests[1]?.input ?? []);
      expect(continuationJson).toContain("Continue from the compacted transcript");
      expect(continuationJson).not.toContain("capture compaction state");

      const reasoningJson = expectCompactionReplay(modelServer.requests[2]?.input ?? []);
      expect(reasoningJson.split("Continue from the compacted transcript")).toHaveLength(2);
      expect(
        reasoningJson.split("recorded reasoning but did not produce a user-visible answer"),
      ).toHaveLength(2);

      await runAgentTurn(client, "replay compaction state");
      expect(modelServer.requests).toHaveLength(4);
      const replayInput = modelServer.requests[3]?.input ?? [];
      const encodedReplayInput = expectCompactionReplay(replayInput);
      const compactionIndex = replayInput.findIndex(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "compaction",
      );
      expect(compactionIndex).toBeGreaterThan(0);
      for (const item of replayInput.slice(0, compactionIndex)) {
        expect(item).toMatchObject({
          type: "message",
          role: expect.stringMatching(/^(developer|system)$/u),
        });
      }
      expect(encodedReplayInput).not.toContain("capture compaction state");
      expect(encodedReplayInput).toContain("gateway replay response 3");
      expect(encodedReplayInput).toContain("replay compaction state");
    } finally {
      await disconnectGatewayClient(client);
    }
  },
);

async function runAgentTurn(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  message: string,
) {
  const runId = randomUUID();
  const response = await client.request<{ runId?: string; status?: string }>(
    "agent",
    { sessionKey: SESSION_KEY, message, deliver: false, idempotencyKey: runId },
    { expectFinal: true, timeoutMs: 120_000 },
  );
  expect(response).toMatchObject({ status: "ok", runId });
}

function expectCompactionReplay(input: unknown[]): string {
  expect(input).toContainEqual({
    type: "compaction",
    id: COMPACTION_ID,
    encrypted_content: COMPACTION_DATA,
  });
  return JSON.stringify(input);
}

async function startMockModelServer() {
  const requests: CapturedRequest[] = [];
  const server = await startOpenAiResponsesModelServer({
    modelId: "replay-proof",
    bindError: "compaction replay model server did not bind",
    onRequest: async (request, response) => {
      requests.push((await json(request)) as CapturedRequest);
      writeModelResponse(response, requests.length);
    },
  });
  return { ...server, requests };
}

function writeModelResponse(response: ServerResponse, sequence: number): void {
  const incomplete = sequence === 1;
  const status = incomplete ? "incomplete" : "completed";
  const item = incomplete
    ? { type: "compaction", id: COMPACTION_ID, encrypted_content: COMPACTION_DATA }
    : sequence === 2
      ? {
          type: "reasoning",
          id: "rs_gateway_replay_2",
          encrypted_content: "opaque-gateway-reasoning",
          summary: [{ type: "summary_text", text: "Working from the compacted transcript." }],
        }
      : {
          type: "message",
          id: `msg_gateway_replay_${sequence}`,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: `gateway replay response ${sequence}`, annotations: [] },
          ],
        };
  const initialItem = incomplete
    ? item
    : sequence === 2
      ? { type: item.type, id: item.id }
      : { ...item, status: "in_progress", content: [] };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: initialItem },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: `response.${status}`,
      response: {
        id: `resp_gateway_replay_${sequence}`,
        status,
        ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output: [item],
        usage: incomplete
          ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
          : { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}
