// E2E: persisted OpenAI Responses compaction state reaches the next Gateway request.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const TEST_TIMEOUT_MS = 180_000;
const SESSION_KEY = "agent:main:compaction-replay";
const COMPACTION_ID = "cmp_gateway_replay";
const COMPACTION_DATA = "opaque-gateway-compaction";

type CapturedRequest = {
  body: { input?: unknown[] };
};

type MockModelServer = OpenAiResponsesModelServer & {
  requests: CapturedRequest[];
};

type MockSseEvent = { type: string } & Record<string, unknown>;

const instances: OpenClawTestInstance[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway OpenAI Responses compaction replay", () => {
  it(
    "replays persisted provider state on the next embedded turn",
    { timeout: TEST_TIMEOUT_MS },
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
        const contextMessages = manager.buildSessionContext().messages;
        const persistedReplay = contextMessages.find(
          (message) => message.role === "assistant",
        )?.providerReplay;
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
        const continuationInput = modelServer.requests[1]?.body.input ?? [];
        expectCompactionReplay(continuationInput);
        const encodedContinuationInput = JSON.stringify(continuationInput);
        expect(encodedContinuationInput).toContain("Continue from the compacted transcript");
        expect(encodedContinuationInput).not.toContain("capture compaction state");

        const reasoningContinuationInput = modelServer.requests[2]?.body.input ?? [];
        expectCompactionReplay(reasoningContinuationInput);
        const encodedReasoningContinuationInput = JSON.stringify(reasoningContinuationInput);
        expectTextOnce(encodedReasoningContinuationInput, "Continue from the compacted transcript");
        expectTextOnce(
          encodedReasoningContinuationInput,
          "recorded reasoning but did not produce a user-visible answer",
        );

        await runAgentTurn(client, "replay compaction state");
        expect(modelServer.requests).toHaveLength(4);
        const replayInput = modelServer.requests[3]?.body.input ?? [];
        expectCompactionReplay(replayInput);
        const compactionIndex = replayInput.findIndex(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: unknown }).type === "compaction",
        );
        expect(compactionIndex).toBeGreaterThan(0);
        const instructionPrefixShape = replayInput.slice(0, compactionIndex).map((item) => {
          if (typeof item !== "object" || item === null) {
            return "unknown";
          }
          const record = item as { role?: unknown; type?: unknown };
          return `${String(record.type)}:${String(record.role)}`;
        });
        expect(
          instructionPrefixShape.every((item) => /^message:(developer|system)$/u.test(item)),
          `unexpected item before compaction: ${instructionPrefixShape.join(",")}`,
        ).toBe(true);
        const encodedReplayInput = JSON.stringify(replayInput);
        expect(encodedReplayInput).not.toContain("capture compaction state");
        expect(encodedReplayInput).toContain("gateway replay response 3");
        expect(encodedReplayInput).toContain("replay compaction state");
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

async function runAgentTurn(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  message: string,
): Promise<string> {
  const runId = randomUUID();
  const response = await client.request<{ runId?: string; status?: string }>(
    "agent",
    {
      sessionKey: SESSION_KEY,
      message,
      deliver: false,
      idempotencyKey: runId,
    },
    { expectFinal: true, timeoutMs: 120_000 },
  );
  expect(response.status).toBe("ok");
  expect(response.runId).toBe(runId);
  return runId;
}

function expectCompactionReplay(input: unknown[]): void {
  expect(input).toContainEqual({
    type: "compaction",
    id: COMPACTION_ID,
    encrypted_content: COMPACTION_DATA,
  });
}

function expectTextOnce(encodedInput: string, text: string): void {
  expect(encodedInput.split(text)).toHaveLength(2);
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: CapturedRequest[] = [];
  const server = await startOpenAiResponsesModelServer({
    modelId: "replay-proof",
    bindError: "compaction replay model server did not bind",
    onRequest: (request, response) => handleRequest(request, response, requests),
  });
  return { ...server, requests };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest["body"];
  requests.push({ body });
  writeModelResponse(response, requests.length);
}

function writeModelResponse(response: ServerResponse, sequence: number): void {
  if (sequence === 1) {
    const compaction = {
      type: "compaction",
      id: COMPACTION_ID,
      encrypted_content: COMPACTION_DATA,
    };
    writeOpenAiResponsesSse(response, [
      { type: "response.output_item.added", output_index: 0, item: compaction },
      { type: "response.output_item.done", output_index: 0, item: compaction },
      {
        type: "response.incomplete",
        response: {
          id: "resp_gateway_replay_1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [compaction],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      },
    ]);
    return;
  }
  if (sequence === 2) {
    const reasoning = {
      type: "reasoning",
      id: "rs_gateway_replay_2",
      encrypted_content: "opaque-gateway-reasoning",
      summary: [{ type: "summary_text", text: "Working from the compacted transcript." }],
    };
    writeOpenAiResponsesSse(response, [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: reasoning.id },
      },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      {
        type: "response.completed",
        response: {
          id: "resp_gateway_replay_2",
          status: "completed",
          output: [reasoning],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      },
    ]);
    return;
  }
  const text = `gateway replay response ${sequence}`;
  const message = {
    type: "message",
    id: `msg_gateway_replay_${sequence}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const output = [message];
  const events: MockSseEvent[] = output.flatMap((item, outputIndex) => [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : item,
    },
    { type: "response.output_item.done", output_index: outputIndex, item },
  ]);
  events.push({
    type: "response.completed",
    response: {
      id: `resp_gateway_replay_${sequence}`,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  });
  writeOpenAiResponsesSse(response, events);
}
