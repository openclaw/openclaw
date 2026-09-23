import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { stateDirGatewayFixtureEntrypoint } from "../cli/cli-entrypoint.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

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
  async (context) => {
    let fixture = "";
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
    let gateway: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    await runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        // Reuse the prepared native Gateway instead of transforming its graph again in Vitest.
        gateway = await createOpenClawTestInstance({
          name: "stream-completion",
          entrypoint: resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(stateDirGatewayFixtureEntrypoint),
          ),
          gatewayCommandPrefix: [process.execPath],
          gatewayToken: "stream-completion-fixture",
          signal,
          verifyCleanup,
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        });
        gateway.state.applyEnv();
        gateway.env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
        gateway.env.OPENCLAW_TEST_GATEWAY_TOKEN = gateway.gatewayToken;
        const workspace = gateway.state.workspaceDir;
        const agentDir = gateway.state.agentDir("main");
        await fs.mkdir(agentDir, { recursive: true });
        // Isolate terminal stream handling from the separate provider recovery policy.
        await fs.writeFile(
          path.join(agentDir, "settings.json"),
          JSON.stringify({ retry: { provider: { maxRetries: 0 } } }),
        );
        fixture = path.join(workspace, "fixture.txt");
        await fs.writeFile(fixture, "COMPLETE_TOOL_READ_MARKER");
        await new Promise<void>((resolve) => {
          provider.listen(0, "127.0.0.1", resolve);
        });
        const address = provider.address();
        if (!address || typeof address === "string") {
          throw new Error("loopback provider did not bind");
        }
        await gateway.state.writeConfig({
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
          gateway: { auth: { mode: "token", token: gateway.gatewayToken } },
        });
        await gateway.startGateway();
        client = await connectGatewayClient({
          deviceIdentity: loadOrCreateDeviceIdentity({ identityKey: "stream-completion-client" }),
          url: gateway.url,
          token: gateway.gatewayToken,
          signal,
          verifyCleanup,
          onEvent: (event) => {
            events.push(event);
          },
        });
        for (scenario of cases) {
          requests = [];
          events.length = 0;
          const sessionKey = `agent:main:stream-${scenario}`;
          const started = await client.request<{ runId: string; status: string }>(
            "chat.send",
            {
              sessionKey,
              message: "Read fixture.txt and report the result.",
              deliver: false,
              idempotencyKey: `stream-${scenario}`,
            },
            { signal },
          );
          expect(started.status).toBe("started");
          const waited = await client.request<{ status: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000, signal },
          );
          expect(waited.status, scenario).not.toBe("timeout");
          const history = await client.request<{ messages: ChatMessage[] }>(
            "chat.history",
            { sessionKey, limit: 30 },
            { signal },
          );
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
      },
      async () => {
        if (client) {
          await disconnectGatewayClient(client);
        }
      },
      async () => {
        await gateway?.cleanup();
      },
      async () => {
        if (!provider.listening) {
          return;
        }
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          provider.close((error) => (error ? reject(error) : resolve()));
        });
      },
    );
  },
);
