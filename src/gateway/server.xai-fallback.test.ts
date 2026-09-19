import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const primaryModel = "grok-4.6";
const fallbackModel = "fallback-proof";
const marker = "XAI_FALLBACK_REPLY";
const prefix = "The answer is";
const continuation = "The answer is 42.";
const tokenGenerationError = "Internal error during token generation";
const authError = `Incorrect API key provided. ${tokenGenerationError}`;
const rejections = new Map<
  string,
  {
    status?: number;
    code?: string;
    type?: string;
    message: string;
    reason: "auth" | "billing" | "rate_limit";
  }
>([
  ...[400, 401, 403, 404, 410, 422].map(
    (status) => [`auth-${status}`, { status, message: authError, reason: "auth" }] as const,
  ),
  ["auth-code", { code: "credential_rejected", message: authError, reason: "auth" }],
  ["auth-type", { type: "upstream_error", message: authError, reason: "auth" }],
  ["auth-text", { message: authError, reason: "auth" }],
  [
    "billing",
    {
      status: 403,
      message: `You have run out of credits. ${tokenGenerationError}`,
      reason: "billing",
    },
  ],
  [
    "rate-limit",
    {
      status: 403,
      message: `Rate limit exceeded. ${tokenGenerationError}`,
      reason: "rate_limit",
    },
  ],
]);
const scenarios = [
  "fallback",
  "continuation",
  "visible-fallback",
  "no-fallback",
  "exhausted",
  ...rejections.keys(),
] as const;
type Scenario = (typeof scenarios)[number];
const model = (id: string) => ({
  id,
  name: id,
  api: "openai-responses",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 256,
});
const encodeEvent = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function messageText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

it(
  "chat.send preserves xAI rejection priority and recovers statusless failures",
  {
    timeout: 180_000,
  },
  async () => {
    const root = tempDirs.make("openclaw-xai-fallback-");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await Promise.all([state, workspace].map((directory) => fs.mkdir(directory)));
    for (const name of scenarios) {
      const agentDir = path.join(state, "agents", name, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ retry: { provider: { maxRetries: 1 } } }),
      );
    }
    const configPath = path.join(state, "openclaw.json");
    const env = {
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
    };
    const snapshot = captureEnv(Object.keys(env));
    for (const [key, value] of Object.entries(env)) {
      setTestEnvValue(key, value);
    }
    let scenario: Scenario = "fallback";
    let requests: string[] = [];
    const events: ChatEvent[] = [];
    const fallbackEvents: unknown[] = [];
    const provider = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: primaryModel }, { id: fallbackModel }] }));
          return;
        }
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/responses");
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const payload: { model: string } = JSON.parse(body);
        requests.push(payload.model);
        const rejection = rejections.get(scenario);
        if (payload.model === primaryModel && rejection) {
          const error = {
            message: rejection.message,
            code: rejection.code,
            type: rejection.type,
          };
          if (rejection.status !== undefined) {
            response.writeHead(rejection.status, { "content-type": "application/json" });
            response.end(JSON.stringify({ error }));
          } else {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(encodeEvent({ error }));
          }
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const recovered = scenario === "continuation" && requests.length === 2;
        if ((payload.model === primaryModel && !recovered) || scenario === "exhausted") {
          const item = {
            type: "message",
            id: `failed-${requests.length}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: prefix, annotations: [] }],
          };
          if (scenario !== "fallback") {
            response.write(
              encodeEvent({
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, status: "in_progress", content: [] },
              }),
            );
            response.write(
              encodeEvent({
                type: "response.output_text.delta",
                output_index: 0,
                item_id: item.id,
                content_index: 0,
                delta: prefix,
              }),
            );
            response.write(
              encodeEvent({ type: "response.output_item.done", output_index: 0, item }),
            );
          }
          response.end(
            encodeEvent({
              type: "response.failed",
              response: {
                id: `failure-${requests.length}`,
                status: "failed",
                error: { code: null, message: tokenGenerationError },
                output: scenario === "fallback" ? [] : [item],
                usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
              },
            }),
          );
          return;
        }
        const message = {
          type: "message",
          id: "fallback",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: recovered ? continuation : marker, annotations: [] },
          ],
        };
        response.end(
          [
            encodeEvent({
              type: "response.output_item.added",
              output_index: 0,
              item: { ...message, status: "in_progress", content: [] },
            }),
            encodeEvent({ type: "response.output_item.done", output_index: 0, item: message }),
            encodeEvent({
              type: "response.completed",
              response: {
                id: "fallback-response",
                status: "completed",
                output: [message],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              },
            }),
          ].join(""),
        );
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", resolve);
      });
      const address = provider.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback provider address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: { workspace, skipBootstrap: true },
            entries: Object.fromEntries(
              scenarios.map((name) => [
                name,
                {
                  default: name === "fallback",
                  model: {
                    primary: `xai/${primaryModel}`,
                    fallbacks: name === "no-fallback" ? [] : [`openai/${fallbackModel}`],
                  },
                },
              ]),
            ),
          },
          models: {
            mode: "replace",
            providers: {
              xai: {
                baseUrl,
                apiKey: "test",
                api: "openai-responses",
                models: [model(primaryModel)],
              },
              openai: {
                baseUrl,
                apiKey: "test",
                api: "openai-responses",
                models: [model(fallbackModel)],
              },
            },
          },
          plugins: {
            allow: ["xai", "openai"],
            slots: { memory: "none" },
            entries: { xai: { enabled: true }, openai: { enabled: true } },
          },
          logging: { file: path.join(root, "gateway.log") },
        },
        configPath,
        token: "xai-fallback-test",
        onEvent: (event) => {
          if (event.event === "chat") {
            events.push(event.payload as ChatEvent);
          }
          if (
            event.event === "agent" &&
            isRecord(event.payload) &&
            isRecord(event.payload.data) &&
            event.payload.data.phase === "fallback"
          ) {
            fallbackEvents.push(event.payload);
          }
        },
      });
      const installed = getActivePluginRegistry()?.providers.find(
        (entry) => entry.provider.id === "xai",
      );
      expect(installed?.pluginId).toBe("xai");
      expect(typeof installed?.provider.classifyFailoverReason).toBe("function");
      for (const selected of scenarios) {
        scenario = selected;
        requests = [];
        const rejection = rejections.get(scenario);
        const sessionKey = `agent:${scenario}:xai-fallback`;
        const started = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Reply with the marker.",
          deliver: false,
          idempotencyKey: `xai-${scenario}`,
        });
        const completed = await gateway.client.request<{
          status: string;
          terminalReply?: { text?: string };
        }>(
          "agent.wait",
          {
            runId: started.runId,
            timeoutMs: 60_000,
          },
          { timeoutMs: 65_000 },
        );
        expect(completed.status, scenario).not.toBe("timeout");
        const history = await gateway.client.request<{
          messages: Array<{ role: string; content: unknown; stopReason?: string }>;
        }>("chat.history", { sessionKey, limit: 20 });
        const assistant = history.messages.findLast((message) => message.role === "assistant");
        expect.soft(requests[0], scenario).toBe(primaryModel);
        expect
          .soft(
            requests.filter((requested) => requested === primaryModel),
            scenario,
          )
          .toHaveLength(rejection && rejection.reason !== "rate_limit" ? 1 : 2);
        const runEvents = events.filter((event) => event.runId === started.runId);
        const terminal = runEvents
          .filter((event) => event.state === "final")
          .filter((event) => event.stopReason === "stop");
        if (rejection || ["fallback", "continuation", "visible-fallback"].includes(scenario)) {
          const expected = scenario === "continuation" ? continuation : marker;
          if (scenario === "continuation") {
            expect.soft(requests, scenario).not.toContain(fallbackModel);
          } else {
            expect.soft(requests, scenario).toContain(fallbackModel);
          }
          expect.soft(completed.status, scenario).toBe("ok");
          expect.soft(assistant?.stopReason, scenario).toBe("stop");
          expect.soft(messageText(assistant), scenario).toBe(expected);
          expect.soft(completed.terminalReply?.text, scenario).toBe(expected);
          expect.soft(terminal, scenario).toHaveLength(1);
          expect.soft(messageText(terminal[0]?.message), scenario).toBe(expected);
          if (rejection) {
            expect.soft(fallbackEvents, scenario).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  runId: started.runId,
                  data: expect.objectContaining({
                    attempts: expect.arrayContaining([
                      expect.objectContaining({
                        provider: "xai",
                        model: primaryModel,
                        reason: rejection.reason,
                        ...(rejection.status === undefined ? {} : { status: rejection.status }),
                      }),
                    ]),
                  }),
                }),
              ]),
            );
          }
        } else {
          expect.soft(completed.status, scenario).toBe("error");
          expect.soft(messageText(assistant), scenario).toBe(prefix);
          const deltas = runEvents.filter((event) => event.state === "delta");
          expect.soft(messageText(deltas.at(-1)?.message), scenario).toBe(prefix);
          if (scenario === "no-fallback") {
            expect.soft(requests, scenario).not.toContain(fallbackModel);
          } else {
            expect.soft(requests, scenario).toContain(fallbackModel);
          }
        }
      }
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => {
          provider.close(() => resolve());
        });
        snapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }
  },
);
