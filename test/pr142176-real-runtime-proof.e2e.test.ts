// A truncated tool call must fail closed, then recover through the bounded empty-error retry.
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const RECOVERED_MARKER = "PR142176_RECOVERED_AFTER_REJECTION";
const TOKEN = "pr142176-proof-token";

function anthropicTurn(rejected: boolean): string {
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_pr142176_${rejected ? "rejected" : "recovered"}`,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 640, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: rejected
        ? { type: "tool_use", id: "call_truncated", name: "read", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: rejected
        ? { type: "input_json_delta", partial_json: '{"path":"/workspace/notes' }
        : { type: "text_delta", text: RECOVERED_MARKER },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: rejected ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: rejected ? 1329 : 12 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "sk-ant-api03-pr142176-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

it(
  "retries a pre-dispatch tool-call rejection through the real transport and recovers",
  { timeout: 90_000 },
  async () => {
    const fixture = await createFixture("openclaw-pr142176-proof-", TOKEN);
    const { configPath } = fixture;
    let providerServer: ReturnType<typeof createServer> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const providerRequests: Array<{ method: string; url: string; stream: unknown }> = [];

    try {
      providerServer = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const parsed = JSON.parse(body) as { stream?: unknown };
          providerRequests.push({
            method: request.method ?? "",
            url: request.url ?? "",
            stream: parsed.stream,
          });
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
          response.end(anthropicTurn(providerRequests.length === 1));
        });
      });
      const providerUrl = await listenProofProvider(providerServer);
      const provider = buildMockAnthropicProvider(providerUrl);
      const cfg = fixture.config(provider);
      const sessionKey = "agent:main:pr142176-proof";
      gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token: TOKEN,
        clientDisplayName: "pr142176-proof",
      });
      const started = await gateway.client.request<{ runId?: string; status?: string }>(
        "chat.send",
        {
          sessionKey,
          message: "read my notes",
          deliver: false,
          idempotencyKey: "pr142176-proof-turn",
        },
      );
      expect(started.status).toBe("started");
      const waited = await gateway.client.request<{ status?: string }>(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(waited).toMatchObject({ status: "ok" });

      // Both attempts went to the real transport over HTTP as streaming Messages requests.
      expect(providerRequests).toEqual([
        { method: "POST", url: "/v1/messages", stream: true },
        { method: "POST", url: "/v1/messages", stream: true },
      ]);

      const history = await gateway.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      const serialized = JSON.stringify(history.messages ?? []);
      expect(serialized).toContain(RECOVERED_MARKER);
      expect(serialized).not.toContain("malformed JSON arguments");
      expect(serialized).not.toContain("/workspace/notes");
    } finally {
      await fixture.close(gateway, providerServer);
    }
  },
);
