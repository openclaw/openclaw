/**
 * Real runtime proof for PR #142176: a loopback Anthropic-format provider rejects the
 * first turn with a truncated tool-call argument buffer (the transport fails closed and
 * discards the content), and the embedded runner's bounded empty-error retry resubmits
 * the same request and recovers with the provider's second, well-formed response.
 */
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const RECOVERED_MARKER = "PR142176_RECOVERED_AFTER_REJECTION";
const TOKEN = "pr142176-proof-token";

function anthropicSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function messageStart(id: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 640, output_tokens: 0 },
    },
  };
}

/** First turn: a sealed tool_use block whose argument buffer is truncated mid-string. */
function rejectedToolCallTurn(): string {
  return anthropicSse([
    messageStart("msg_pr142176_rejected"),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_truncated", name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":"/workspace/notes' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1329 },
    },
    { type: "message_stop" },
  ]);
}

/** Second turn: a plain text answer carrying the recovery marker. */
function recoveredTextTurn(): string {
  return anthropicSse([
    messageStart("msg_pr142176_recovered"),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: RECOVERED_MARKER },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  ]);
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

describe("PR #142176 real runtime proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "retries a pre-dispatch tool-call rejection through the real transport and recovers",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: Array<{ method: string; url: string; stream: unknown }> = [];

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr142176-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

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
            // Reject the first attempt, answer the resubmitted one.
            response.end(
              providerRequests.length === 1 ? rejectedToolCallTurn() : recoveredTextTurn(),
            );
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockAnthropicProvider(`http://127.0.0.1:${providerAddress.port}`);
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
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
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
