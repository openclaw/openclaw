import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { stateDirGatewayFixtureEntrypoint } from "../cli/cli-entrypoint.test-support.js";
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
  content: unknown;
  openclawRunError?: { runId: string; summary: string };
};

it(
  "chat.send reports incomplete streams and executes only completed tool turns",
  { timeout: 240_000 },
  async (context) => {
    let fixture = "";
    let scenario: Scenario = "started-text";
    let requests: unknown[] = [];
    const events: unknown[] = [];
    const provider = createServer(async (request, response) => {
      const payload: unknown = JSON.parse(await readRequestText(request));
      requests.push({ method: request.method, url: request.url, payload });
      const tool =
        scenario.endsWith("tool") && (scenario !== "compatible-tool" || requests.length === 1);
      const complete = scenario.startsWith("complete") || scenario.startsWith("compatible");
      const frames: unknown[] = [];
      const frame = (type: string, fields: Record<string, unknown> = {}) =>
        frames.push({ type, ...fields });
      frame("message_start", {
        message: {
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: "stream-fixture",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      frame("content_block_start", {
        index: 0,
        content_block: tool
          ? { type: "tool_use", id: "call_read_fixture", name: "read", input: {} }
          : { type: "text", text: "" },
      });
      frame("content_block_delta", {
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: JSON.stringify({ path: fixture }) }
          : { type: "text_delta", text: complete ? "COMPLETE_REPLY_MARKER" : "Partial answer" },
      });
      if (!scenario.startsWith("started")) {
        frame("content_block_stop", { index: 0 });
      }
      if (complete) {
        frame("message_delta", {
          delta: { stop_reason: tool ? "tool_use" : "end_turn" },
          usage: { output_tokens: 4 },
        });
      }
      if (scenario === "complete-text") {
        frame("message_stop");
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
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
        const baseUrl = await listenLoopback(provider);
        await gateway.state.writeConfig({
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              model: { primary: "stream-fixture/stream-fixture" },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: {
              "stream-fixture": {
                baseUrl,
                apiKey: "local-fixture-key",
                api: "anthropic-messages",
                models: [
                  {
                    id: "stream-fixture",
                    name: "Stream fixture",
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
        const connected = await connectGatewayClient({
          url: gateway.url,
          token: gateway.gatewayToken,
          signal,
          verifyCleanup,
          onEvent: (event) => {
            events.push(event);
          },
        });
        client = connected;
        const rpc = <T>(
          method: string,
          params: Record<string, unknown>,
          options: { timeoutMs?: number } = {},
        ) => connected.request<T>(method, params, { signal, ...options });
        for (scenario of cases) {
          requests = [];
          events.length = 0;
          const sessionKey = `agent:main:stream-${scenario}`;
          const started = await rpc<{ runId: string; status: string }>("chat.send", {
            sessionKey,
            message: "Read fixture.txt and report the result.",
            deliver: false,
            idempotencyKey: `stream-${scenario}`,
          });
          expect(started.status).toBe("started");
          const waited = await rpc<{ status: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );
          expect(waited.status, scenario).not.toBe("timeout");
          const history = await rpc<{ messages: ChatMessage[] }>("chat.history", {
            sessionKey,
            limit: 30,
          });
          const assistant = history.messages.findLast((message) => message.role === "assistant");
          const toolResults = history.messages.filter((message) => message.role === "toolResult");
          const check = <T>(value: T) => expect.soft(value, scenario);
          const chatEvent = (state: string) =>
            expect.objectContaining({
              event: "chat",
              payload: expect.objectContaining({ runId: started.runId, state }),
            });
          if (scenario.startsWith("started") || scenario.startsWith("sealed")) {
            check(waited.status).toBe("error");
            check(
              history.messages.filter(
                (message) => message.openclawRunError?.runId === started.runId,
              ),
            ).toEqual([
              expect.objectContaining({
                role: "custom",
                openclawRunError: { runId: started.runId, summary: expect.stringMatching(/\S/) },
              }),
            ]);
            if (scenario.endsWith("text")) {
              check(JSON.stringify(assistant?.content)).toContain("Partial answer");
            }
            check(toolResults).toHaveLength(0);
            check(events).toContainEqual(chatEvent("error"));
            check(events).not.toContainEqual(chatEvent("final"));
          } else {
            check(waited.status).toBe("ok");
            check(JSON.stringify(assistant?.content)).toContain("COMPLETE_REPLY_MARKER");
            check(requests).toHaveLength(scenario === "compatible-tool" ? 2 : 1);
            check(toolResults).toHaveLength(scenario === "compatible-tool" ? 1 : 0);
            if (scenario === "compatible-tool") {
              check(JSON.stringify(requests[1])).toContain("COMPLETE_TOOL_READ_MARKER");
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
        await closeHttpServer(provider);
      },
    );
  },
);
