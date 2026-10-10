/**
 * Real runtime proof for PR #168270: a loopback Anthropic-format provider streams a large argument
 * for a non-edit tool over several seconds. The embedded runner must emit counts-only
 * `tool` / `input_delta` progress for that call while its input streams, before the
 * tool starts, and must never put argument content in those events.
 */
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../packages/gateway-protocol/src/client-info.js";
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
// Claude 5-family ids take the streaming-refusal contract, which holds every delta
// until the terminal event; a pre-5 id streams deltas live.
const MODEL_ID = "claude-sonnet-4-5";
const TOKEN = "tool-input-progress-proof-token";
const TOOL_CALL_ID = "call_large_read";
const ARGUMENT_MARKER = "ARGUMENT_CONTENT_MUST_NOT_LEAK";
const DONE_MARKER = "TOOL_INPUT_PROGRESS_DONE";
const CHUNK_COUNT = 8;
const CHUNK_DELAY_MS = 350;

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
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

/** The large argument a slow model would generate: ~40KB for a non-edit tool. */
function largeArgumentChunks(): string[] {
  const padding = `${ARGUMENT_MARKER}-`.repeat(Math.ceil(40_000 / (ARGUMENT_MARKER.length + 1)));
  const json = JSON.stringify({ path: `notes/${padding}.md` });
  const size = Math.ceil(json.length / CHUNK_COUNT);
  return Array.from({ length: CHUNK_COUNT }, (_, index) =>
    json.slice(index * size, (index + 1) * size),
  );
}

/** First turn: stream one `read` tool call's input slowly, like a long generation. */
async function streamLargeToolCallTurn(response: ServerResponse): Promise<void> {
  response.write(sse(messageStart("msg_tool_input_progress_tool")));
  response.write(
    sse({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: TOOL_CALL_ID, name: "read", input: {} },
    }),
  );
  for (const chunk of largeArgumentChunks()) {
    response.write(
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: chunk },
      }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHUNK_DELAY_MS);
    });
  }
  response.write(sse({ type: "content_block_stop", index: 0 }));
  response.write(
    sse({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 12_000 },
    }),
  );
  response.end(sse({ type: "message_stop" }));
}

function finalTextTurn(): string {
  return [
    messageStart("msg_tool_input_progress_done"),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: DONE_MARKER } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  ]
    .map(sse)
    .join("");
}

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Mock Claude Sonnet 4.5",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "sk-ant-api03-tool-input-progress-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

type ToolEventData = { phase?: string; toolCallId?: string; name?: string; inputChars?: number };

describe("tool input progress real runtime proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "emits counts-only input progress for a non-edit tool before it starts",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let providerRequests = 0;
      const toolEvents: Array<{ data: ToolEventData; serialized: string }> = [];

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-input-progress-"));
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
          request.resume();
          request.on("end", () => {
            providerRequests += 1;
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            if (providerRequests === 1) {
              void streamLargeToolCallTurn(response);
            } else {
              response.end(finalTextTurn());
            }
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
            entries: { main: {} },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "tool-input-progress-proof",
          caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
          onEvent: (event) => {
            const payload = event.payload as { stream?: string; data?: ToolEventData } | undefined;
            if (event.event === "agent" && payload?.stream === "tool" && payload.data) {
              toolEvents.push({ data: payload.data, serialized: JSON.stringify(payload) });
            }
          },
        });
        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey: "agent:main:tool-input-progress-proof",
            message: "read the long notes file",
            deliver: false,
            idempotencyKey: "tool-input-progress-proof-turn",
          },
        );
        expect(started.status).toBe("started");
        const waited = await gateway.client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(waited).toMatchObject({ status: "ok" });
        expect(providerRequests).toBe(2);

        const forCall = toolEvents.filter((event) => event.data.toolCallId === TOOL_CALL_ID);
        const progress = forCall.filter((event) => event.data.phase === "input_delta");
        const firstStart = forCall.findIndex((event) => event.data.phase === "start");
        const lastProgress = forCall.findLastIndex((event) => event.data.phase === "input_delta");

        // The slow stream spans several throttle windows, so progress must repeat.
        expect(
          progress.length,
          forCall.map((event) => event.data.phase).join(","),
        ).toBeGreaterThanOrEqual(3);
        expect(firstStart).toBeGreaterThan(lastProgress);
        const chars = progress.map((event) => event.data.inputChars ?? 0);
        expect(chars.every((value, index) => index === 0 || value > chars[index - 1]!)).toBe(true);
        expect(chars.at(-1)).toBeGreaterThan(30_000);
        for (const event of progress) {
          expect(event.data).toMatchObject({ name: "read" });
          expect(event.data).not.toHaveProperty("diff");
          expect(event.serialized).not.toContain(ARGUMENT_MARKER);
        }
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          providerServer.closeAllConnections();
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
