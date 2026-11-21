import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { json } from "node:stream/consumers";
import { expect, test } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  closeHttpServer,
  connectProofClient,
  listenLoopback,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

// Transport suites cover tool-loop aliases; this covers persisted Gateway history.
test(
  "Gateway retains custom openai endpoint reasoning on the next agent turn",
  { timeout: 150_000 },
  async () => {
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          respondJson(response, { data: [{ id: "replay-proof", object: "model" }] });
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        requests.push(await json(request));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta =
          requests.length === 1
            ? {
                role: "assistant",
                reasoning: "Synthetic replay marker.",
                content: "First proof complete.",
              }
            : { role: "assistant", content: "Second proof complete." };
        for (const choice of [
          { index: 0, delta, finish_reason: null },
          { index: 0, delta: {}, finish_reason: "stop" },
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: "replay-proof", choices: [choice] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) =>
        respondJson(response, { error: { message: String(error) } }, 500),
      );
    });
    const baseUrl = await listenLoopback(server);
    let instance: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    try {
      instance = await createOpenClawTestInstance({
        name: "custom-endpoint-reasoning-replay",
        config: {
          plugins: { allow: ["openai"], slots: { memory: "none" } },
          agents: {
            defaults: {
              model: { primary: "openai/replay-proof" },
              models: { "openai/replay-proof": { agentRuntime: { id: "openclaw" } } },
              utilityModel: "",
              skipBootstrap: true,
              skills: [],
              thinkingDefault: "medium",
            },
          },
          tools: { profile: "minimal" },
          models: {
            mode: "replace",
            providers: {
              openai: {
                baseUrl: `${baseUrl}/v1`,
                apiKey: "synthetic-proof-only",
                api: "openai-completions",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: "replay-proof",
                    name: "replay-proof",
                    api: "openai-completions",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4_096,
                  },
                ],
              },
            },
          },
        },
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      await instance.startGateway();
      client = await connectProofClient(instance, {
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      for (const [index, message] of [
        "First synthetic proof turn.",
        "Second synthetic proof turn.",
      ].entries()) {
        const runId = randomUUID();
        const result = await client.request<{
          status: string;
          runId: string;
          result?: { payloads?: Array<{ text?: string }> };
        }>(
          "agent",
          {
            sessionKey: "agent:main:reasoning-replay",
            message,
            deliver: false,
            idempotencyKey: runId,
          },
          { expectFinal: true, timeoutMs: 60_000 },
        );
        expect(result).toMatchObject({
          status: "ok",
          runId,
          result: {
            payloads: expect.arrayContaining([
              expect.objectContaining({
                text: index === 0 ? "First proof complete." : "Second proof complete.",
              }),
            ]),
          },
        });
      }
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        model: "replay-proof",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            reasoning: "Synthetic replay marker.",
          }),
        ]),
      });
    } finally {
      try {
        if (client) {
          await disconnectGatewayClient(client);
        }
      } finally {
        try {
          if (instance) {
            await instance.cleanup();
          }
        } finally {
          await closeHttpServer(server);
        }
      }
    }
  },
);
