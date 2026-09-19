import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cases = [
  "started-text",
  "sealed-text",
  "started-tool",
  "sealed-tool",
  "complete-text",
  "compatible-text",
  "compatible-tool",
] as const;
type Scenario = (typeof cases)[number];
type ChatMessage = {
  role: string;
  stopReason?: string;
  content: unknown;
};

it(
  "chat.send reports incomplete streams and executes only completed tool turns",
  { timeout: 240_000 },
  async () => {
    const root = tempDirs.make("openclaw-stream-completion-");
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "state");
    const plugins = path.join(root, "plugins");
    await Promise.all([workspace, state, plugins].map((dir) => fs.mkdir(dir)));
    const agentDir = path.join(state, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    // Isolate terminal stream handling from the separate provider recovery policy.
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ retry: { provider: { maxRetries: 0 } } }),
    );
    const fixture = path.join(workspace, "fixture.txt");
    await fs.writeFile(fixture, "COMPLETE_TOOL_READ_MARKER");
    const configPath = path.join(state, "openclaw.json");
    const env = {
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: "stream-completion-fixture",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: plugins,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const snapshot = captureEnv(Object.keys(env));
    for (const [key, value] of Object.entries(env)) {
      setTestEnvValue(key, value);
    }
    let scenario: Scenario = "started-text";
    let requests: unknown[] = [];
    const events: unknown[] = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload: unknown = JSON.parse(body);
        requests.push({ method: request.method, url: request.url, payload });
        const tool =
          scenario.endsWith("tool") && (scenario !== "compatible-tool" || requests.length === 1);
        const complete = scenario.startsWith("complete") || scenario.startsWith("compatible");
        const frames: unknown[] = [
          {
            type: "message_start",
            message: {
              id: `msg_${requests.length}`,
              type: "message",
              role: "assistant",
              model: "stream-fixture",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
        ];
        frames.push({
          type: "content_block_start",
          index: 0,
          content_block: tool
            ? { type: "tool_use", id: "call_read_fixture", name: "read", input: {} }
            : { type: "text", text: "" },
        });
        frames.push({
          type: "content_block_delta",
          index: 0,
          delta: tool
            ? { type: "input_json_delta", partial_json: JSON.stringify({ path: fixture }) }
            : { type: "text_delta", text: complete ? "COMPLETE_REPLY_MARKER" : "Partial answer" },
        });
        if (!scenario.startsWith("started")) {
          frames.push({ type: "content_block_stop", index: 0 });
        }
        if (complete) {
          frames.push({
            type: "message_delta",
            delta: { stop_reason: tool ? "tool_use" : "end_turn" },
            usage: { output_tokens: 4 },
          });
        }
        if (scenario === "complete-text") {
          frames.push({ type: "message_stop" });
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve) => {
        provider.listen(0, "127.0.0.1", resolve);
      });
      const address = provider.address();
      if (!address || typeof address === "string") {
        throw new Error("loopback provider did not bind");
      }
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              model: { primary: "stream-fixture/stream-fixture" },
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              "stream-fixture": {
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: "local-fixture-key",
                api: "anthropic-messages",
                models: [
                  {
                    id: "stream-fixture",
                    name: "Stream fixture",
                    api: "anthropic-messages",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
          gateway: { auth: { mode: "token", token: env.OPENCLAW_GATEWAY_TOKEN } },
        },
        configPath,
        token: env.OPENCLAW_GATEWAY_TOKEN,
        onEvent: (event) => {
          events.push(event);
        },
      });
      for (scenario of cases) {
        requests = [];
        events.length = 0;
        const sessionKey = `agent:main:stream-${scenario}`;
        const started = await gateway.client.request<{ runId: string; status: string }>(
          "chat.send",
          {
            sessionKey,
            message: "Read fixture.txt and report the result.",
            deliver: false,
            idempotencyKey: `stream-${scenario}`,
          },
        );
        expect(started.status).toBe("started");
        const waited = await gateway.client.request<{ status: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        expect(waited.status, scenario).not.toBe("timeout");
        const history = await gateway.client.request<{ messages: ChatMessage[] }>("chat.history", {
          sessionKey,
          limit: 30,
        });
        const assistant = history.messages.findLast((message) => message.role === "assistant");
        const toolResults = history.messages.filter((message) => message.role === "toolResult");
        console.log(
          JSON.stringify({
            scenario,
            status: waited.status,
            stopReason: assistant?.stopReason,
            requests: requests.length,
            toolResults: toolResults.length,
            content: assistant?.content,
          }),
        );
        if (scenario.startsWith("started") || scenario.startsWith("sealed")) {
          expect.soft(waited.status, scenario).toBe("error");
          expect.soft(assistant?.stopReason, scenario).toBe("error");
          expect.soft(toolResults, scenario).toHaveLength(0);
          expect.soft(events, scenario).toContainEqual(
            expect.objectContaining({
              event: "chat",
              payload: expect.objectContaining({ runId: started.runId, state: "error" }),
            }),
          );
          expect.soft(events, scenario).not.toContainEqual(
            expect.objectContaining({
              event: "chat",
              payload: expect.objectContaining({ runId: started.runId, state: "final" }),
            }),
          );
        } else {
          expect.soft(waited.status, scenario).toBe("ok");
          expect
            .soft(JSON.stringify(assistant?.content), scenario)
            .toContain("COMPLETE_REPLY_MARKER");
          expect.soft(requests, scenario).toHaveLength(scenario === "compatible-tool" ? 2 : 1);
          expect.soft(toolResults, scenario).toHaveLength(scenario === "compatible-tool" ? 1 : 0);
          if (scenario === "compatible-tool") {
            expect.soft(JSON.stringify(requests[1])).toContain("COMPLETE_TOOL_READ_MARKER");
          }
        }
      }
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
      snapshot.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
    }
  },
);
