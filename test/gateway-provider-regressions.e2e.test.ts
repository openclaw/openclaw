import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import { zstdDecompressSync } from "node:zlib";
import { expect, test } from "vitest";
import { z } from "zod";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  closeHttpServer,
  connectProofClient,
  listenLoopback,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const requestSchema = z.object({ model: z.string().min(1) }).passthrough();

const modelRow = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1_024,
});
type ProofClient = Awaited<ReturnType<typeof connectProofClient>>;
type AgentResult = { status: string; result?: { payloads?: Array<{ text?: string }> } };

async function turn(client: ProofClient, provider: string, model: string) {
  return client.request<AgentResult>(
    "agent",
    {
      provider,
      model,
      sessionKey: "agent:main:provider-proof-" + randomUUID(),
      message: "Reply with the synthetic fixture acknowledgement.",
      deliver: false,
      idempotencyKey: randomUUID(),
    },
    { expectFinal: true, timeoutMs: 60_000 },
  );
}

function expectReply(result: AgentResult, text: string) {
  expect(result).toMatchObject({
    status: "ok",
    result: { payloads: expect.arrayContaining([expect.objectContaining({ text })]) },
  });
}

function anthropicReply(response: ServerResponse, model: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-proof",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ANTHROPIC-ACK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  response.end(
    events
      .map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")
      .join(""),
  );
}

// Real registration, classification, recovery, configured fallback and final RPC output.
// One refusal per model bounds the baseline to one wrong retry, not a 10-minute loop.
test(
  "Gateway sends credits_required to fallback but still retries ordinary Anthropic 429",
  { timeout: 150_000 },
  async () => {
    const requests: string[] = [];
    const failures = new Set<string>();
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET") {
          respondJson(response, { data: [modelRow("credits-proof"), modelRow("throttle-proof")] });
          return;
        }
        const body = requestSchema.parse(await json(request));
        requests.push(body.model);
        if (request.url === "/v1/chat/completions") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            "data: " +
              JSON.stringify({
                id: "fallback",
                object: "chat.completion.chunk",
                created: 1,
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "FALLBACK-ACK" },
                    finish_reason: "stop",
                  },
                ],
              }) +
              "\n\ndata: [DONE]\n\n",
          );
          return;
        }
        if (request.url !== "/v1/messages") {
          response.writeHead(404).end();
          return;
        }
        if (!failures.has(body.model)) {
          failures.add(body.model);
          respondJson(
            response,
            {
              type: "error",
              error: {
                type: "rate_limit_error",
                message: "Synthetic rate limit refusal.",
                ...(body.model === "credits-proof"
                  ? { details: { error_code: "credits_required" } }
                  : {}),
              },
            },
            429,
          );
          return;
        }
        anthropicReply(response, body.model);
      })().catch((error: unknown) => respondJson(response, { error: String(error) }, 500));
    });
    const baseUrl = await listenLoopback(server);
    let instance: OpenClawTestInstance | undefined;
    let client: ProofClient | undefined;
    try {
      instance = await createOpenClawTestInstance({
        name: "anthropic-credits-fallback-proof",
        config: {
          plugins: { allow: ["anthropic", "openai"], slots: { memory: "none" } },
          agents: {
            defaults: {
              model: { primary: "anthropic/credits-proof", fallbacks: ["openai/fallback-proof"] },
              models: Object.fromEntries(
                [
                  "anthropic/credits-proof",
                  "anthropic/throttle-proof",
                  "openai/fallback-proof",
                ].map((ref) => [ref, { agentRuntime: { id: "openclaw" } }]),
              ),
              utilityModel: "",
              skipBootstrap: true,
              skills: [],
              thinkingDefault: "off",
            },
          },
          tools: { profile: "minimal" },
          models: {
            mode: "replace",
            providers: {
              anthropic: {
                baseUrl,
                apiKey: "synthetic-anthropic-proof",
                api: "anthropic-messages",
                request: { allowPrivateNetwork: true },
                models: [modelRow("credits-proof"), modelRow("throttle-proof")],
              },
              openai: {
                baseUrl: baseUrl + "/v1",
                apiKey: "synthetic-fallback-proof",
                api: "openai-completions",
                request: { allowPrivateNetwork: true },
                models: [modelRow("fallback-proof")],
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
      expectReply(await turn(client, "anthropic", "throttle-proof"), "ANTHROPIC-ACK");
      expect(requests).toEqual(["throttle-proof", "throttle-proof"]);
      const result = await turn(client, "anthropic", "credits-proof");
      // First assert the actual retry/fallback route, not merely different output.
      expect(requests.slice(2)).toEqual(["credits-proof", "fallback-proof"]);
      expectReply(result, "FALLBACK-ACK");
    } finally {
      try {
        if (client) {
          await disconnectGatewayClient(client);
        }
      } finally {
        try {
          await instance?.cleanup();
        } finally {
          await closeHttpServer(server);
        }
      }
    }
  },
);

// Bundled catalog donors, not a mocked overlay helper. The nonchat control runs first.
test(
  "Gateway admits dual chat plus Decision on subscription transport and preserves explicit veto",
  { timeout: 150_000 },
  async () => {
    const requests: string[] = [];
    const catalogRequests: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          catalogRequests.push(request.method + " " + request.url);
          // The real catalog owner derives chat + Decision from this grant.
          // Moving it from /catalog-root/v1 to /veto must retain the typed-route veto.
          respondJson(response, {
            version: "clawrouter.client-catalog.v1",
            providers: [
              {
                id: "openai",
                displayName: "OpenAI",
                openaiCompatible: true,
                nativeBaseUrl: "/v1/native/openai",
                routes: [],
                models: [
                  {
                    id: "openai/gpt-6-luna",
                    upstream: "gpt-6-luna",
                    capabilities: ["llm.responses", "llm.chat", "llm.decisions"],
                  },
                ],
              },
            ],
          });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const compressed = Buffer.concat(chunks);
        const bytes =
          request.headers["content-encoding"] === "zstd"
            ? zstdDecompressSync(compressed)
            : compressed;
        const body = requestSchema.parse(JSON.parse(bytes.toString("utf8")));
        requests.push(body.model);
        writeOpenAiResponsesText(response, {
          text: "SUBSCRIPTION-ACK",
          messageId: "msg-subscription",
          responseId: "resp-subscription",
        });
      })().catch((error: unknown) => respondJson(response, { error: String(error) }, 500));
    });
    const baseUrl = await listenLoopback(server);
    let instance: OpenClawTestInstance | undefined;
    let client: ProofClient | undefined;
    try {
      instance = await createOpenClawTestInstance({
        name: "subscription-catalog-overlay-proof",
        config: {
          plugins: { allow: ["openai", "clawrouter"], slots: { memory: "none" } },
          agents: {
            defaults: {
              model: { primary: "openai/gpt-6-luna", fallbacks: [] },
              models: {
                "openai/gpt-6-luna": {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
                "clawrouter/openai/gpt-6-luna": { agentRuntime: { id: "openclaw" } },
              },
              utilityModel: "",
              skipBootstrap: true,
              skills: [],
              thinkingDefault: "off",
            },
          },
          tools: { profile: "minimal" },
          models: {
            // Retain the bundled donor for the route overlay under test.
            mode: "merge",
            providers: {
              openai: {
                // Native provider scope retains the real bundled dual-capability donor;
                // the model-level pin below keeps inference strictly on loopback.
                baseUrl: "https://chatgpt.com/backend-api/codex",
                api: "openai-chatgpt-responses",
                auth: "oauth",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    ...modelRow("gpt-6-luna"),
                    api: "openai-chatgpt-responses",
                    baseUrl: baseUrl + "/backend-api/codex",
                  },
                ],
              },
              clawrouter: {
                baseUrl: baseUrl + "/catalog-root/v1",
                api: "openai-responses",
                apiKey: "synthetic-veto-proof",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    ...modelRow("openai/gpt-6-luna"),
                    api: "openai-responses",
                    baseUrl: baseUrl + "/veto",
                  },
                ],
              },
            },
          },
        },
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      const expires = Date.UTC(2036, 0, 1);
      const access = [
        { alg: "none" },
        {
          "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-subscription" },
          exp: expires / 1_000,
        },
      ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .concat("synthetic")
        .join(".");
      await instance.state.writeAuthProfiles({
        version: 1,
        profiles: {
          "openai:subscription-proof": {
            type: "oauth",
            provider: "openai",
            access,
            refresh: "synthetic-refresh",
            expires,
            accountId: "synthetic-subscription",
          },
        },
        order: { openai: ["openai:subscription-proof"] },
      });
      await instance.startGateway();
      client = await connectProofClient(instance, {
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      // Headless Gateway startup deliberately skips live catalog discovery. Acquire
      // the real grant through the supported catalog RPC before the turn captures it.
      const catalog = await client.request<{ pendingProviders?: string[] }>(
        "models.list",
        { provider: "clawrouter", refresh: true },
        { timeoutMs: 60_000 },
      );
      expect(catalog.pendingProviders ?? []).not.toContain("clawrouter");
      expect(catalogRequests).toContain("GET /catalog-root/v1/catalog");
      expect(requests).toEqual([]);
      // Refusal can be an RPC rejection or terminal agent error; either must name chat.
      const veto = await turn(client, "clawrouter", "openai/gpt-6-luna").catch((error: unknown) =>
        String(error),
      );
      expect(JSON.stringify(veto)).toMatch(/does(?:n't| not) support chat/i);
      expect(requests).toEqual([]);
      const result = await turn(client, "openai", "gpt-6-luna").catch((error: unknown) => ({
        status: "rpc-error",
        error: String(error),
      }));
      // Baseline rejects before HTTP; fixed must serialize a model request and reply.
      expect(requests).toEqual(["gpt-6-luna"]);
      expectReply(result, "SUBSCRIPTION-ACK");
    } finally {
      try {
        if (client) {
          await disconnectGatewayClient(client);
        }
      } finally {
        try {
          await instance?.cleanup();
        } finally {
          await closeHttpServer(server);
        }
      }
    }
  },
);
