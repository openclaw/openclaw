import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
        if (payload.model === primaryModel) {
          response.writeHead(200, { "content-type": "text/event-stream" });
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
        writeOpenAiResponsesText(response, {
          text: marker,
          messageId: "fallback",
          responseId: "fallback-response",
        });
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
        check(requests[0]).toBe(primaryModel);
        check(requests.filter((requested) => requested === primaryModel)).toHaveLength(
          rejection && rejection.reason !== "rate_limit" ? 1 : 2,
        );
        check(requests).toContain(fallbackModel);
        check(completed).toMatchObject({ status: "ok", terminalReply: { text: marker } });
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
