import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectTextContentBlocks } from "../agents/content-blocks.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const primaryModel = "grok-4.6";
const fallbackModel = "fallback-proof";
const marker = "XAI_FALLBACK_REPLY";
const tokenGenerationError = "Internal error during token generation";
const authError = `Incorrect API key provided. ${tokenGenerationError}`;
const rejected403 = (reason: "billing" | "rate_limit", message: string) => ({
  status: 403,
  message: `${message}. ${tokenGenerationError}`,
  reason,
});
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
  ["billing", rejected403("billing", "You have run out of credits")],
  ["rate-limit", rejected403("rate_limit", "Rate limit exceeded")],
]);
// Shared partial-output recovery is exercised by server.chat-recovered-output.test.ts.
const scenarios = ["fallback", ...rejections.keys()] as const;
type Scenario = (typeof scenarios)[number];
const encodeEvent = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const responseMessage = (id: string, text: string) => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const outputEvent = (type: "added" | "done", item: ReturnType<typeof responseMessage>) => ({
  type: `response.output_item.${type}`,
  output_index: 0,
  item: type === "added" ? { ...item, status: "in_progress", content: [] } : item,
});

function messageText(message: unknown): string {
  return isRecord(message) ? collectTextContentBlocks(message.content).join("\n") : "";
}

it(
  "chat.send preserves xAI rejection priority and recovers statusless failures",
  {
    timeout: 180_000,
  },
  async ({ signal }) => {
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
    const terminalEvents = new Map<string, (event: ChatEvent) => void>();
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
        if (payload.model === primaryModel) {
          response.end(
            encodeEvent({
              type: "response.failed",
              response: {
                id: `failure-${requests.length}`,
                status: "failed",
                error: { code: null, message: tokenGenerationError },
                output: [],
                usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
              },
            }),
          );
          return;
        }
        const message = responseMessage("fallback", marker);
        response.end(
          [
            outputEvent("added", message),
            outputEvent("done", message),
            {
              type: "response.completed",
              response: {
                id: "fallback-response",
                status: "completed",
                output: [message],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              },
            },
          ]
            .map(encodeEvent)
            .join(""),
        );
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const baseUrl = await listenProvider(provider);
      const providerConfig = (id: string) => {
        const config = buildMockOpenAiResponsesProvider(baseUrl, id).config;
        Object.assign(config.models[0], { contextWindow: 16_000, maxTokens: 256 });
        return config;
      };
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            ownership: "explicit",
            defaults: {
              workspace,
              skipBootstrap: true,
              systemAgent: { agentId: "fallback" },
            },
            entries: Object.fromEntries(
              scenarios.map((name) => [
                name,
                {
                  model: {
                    primary: `xai/${primaryModel}`,
                    fallbacks: [`openai/${fallbackModel}`],
                  },
                },
              ]),
            ),
          },
          models: {
            mode: "replace",
            providers: {
              xai: providerConfig(primaryModel),
              openai: providerConfig(fallbackModel),
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
            const chatEvent = event.payload as ChatEvent;
            events.push(chatEvent);
            terminalEvents.get(chatEvent.runId)?.(chatEvent);
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
      for (const selected of scenarios) {
        scenario = selected;
        const check = (actual: unknown) => expect.soft(actual, scenario);
        requests = [];
        const rejection = rejections.get(scenario);
        const sessionKey = `agent:${scenario}:xai-fallback`;
        const started = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Reply with the marker.",
          deliver: false,
          idempotencyKey: `xai-${scenario}`,
        });
        const terminalReceived = createDeferred();
        const receiveTerminal = (event: ChatEvent) => {
          if (
            event.sessionKey === sessionKey &&
            event.state === "final" &&
            event.stopReason === "stop"
          ) {
            terminalReceived.resolve();
          }
        };
        terminalEvents.set(started.runId, receiveTerminal);
        // The expected terminal may arrive before chat.send acknowledges its run ID.
        for (const event of events) {
          if (event.runId === started.runId) {
            receiveTerminal(event);
          }
        }
        const completed = await gateway.client.request<{
          status: string;
          error?: string;
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
        // Status-notice finals do not settle the transcript-gated successful reply.
        await withinTest(terminalReceived.promise, signal);
        terminalEvents.delete(started.runId);
        const history = await gateway.client.request<{
          messages: Array<{ role: string; content: unknown; stopReason?: string }>;
        }>("chat.history", { sessionKey, limit: 20 });
        const assistant = history.messages.findLast((message) => message.role === "assistant");
        const runEvents = events.filter((event) => event.runId === started.runId);
        check(requests[0]).toBe(primaryModel);
        check(requests.filter((requested) => requested === primaryModel)).toHaveLength(
          rejection && rejection.reason !== "rate_limit" ? 1 : 2,
        );
        const terminal = runEvents
          .filter((event) => event.state === "final")
          .filter((event) => event.stopReason === "stop");
        check(requests).toContain(fallbackModel);
        check(completed.status).toBe("ok");
        check(assistant?.stopReason).toBe("stop");
        check(messageText(assistant)).toBe(marker);
        check(completed.terminalReply?.text).toBe(marker);
        check(terminal).toHaveLength(1);
        check(messageText(terminal[0]?.message)).toBe(marker);
        if (rejection) {
          check(fallbackEvents).toContainEqual(
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
          );
        }
      }
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      } finally {
        await closeProvider(provider);
        snapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }
  },
);
