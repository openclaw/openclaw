import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { mergeChatStreamMessage } from "../../packages/gateway-client/src/chat-stream-message.js";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
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
type Rejection = {
  status?: number;
  code?: string;
  type?: string;
  message: string;
  reason: "auth" | "billing" | "rate_limit";
};
const makeRejection = (reason: Rejection["reason"], message: string, status = 403) => ({
  reason,
  message: `${message} ${tokenGenerationError}`,
  status,
});
const rejections = new Map<string, Rejection>([
  ...[400, 401, 403, 404, 410, 422].map(
    (status) => [`auth-${status}`, { status, message: authError, reason: "auth" }] as const,
  ),
  ["auth-code", { code: "credential_rejected", message: authError, reason: "auth" }],
  ["auth-type", { type: "upstream_error", message: authError, reason: "auth" }],
  ["auth-text", { message: authError, reason: "auth" }],
  ["billing", makeRejection("billing", "You have run out of credits.")],
  ["rate-limit", makeRejection("rate_limit", "Rate limit exceeded.")],
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
const outputMessage = (id: string, text: string) => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
type OutputMessage = ReturnType<typeof outputMessage>;
const itemEvent = (item: OutputMessage, added = false) =>
  encodeEvent({
    type: added ? "response.output_item.added" : "response.output_item.done",
    output_index: 0,
    item: added ? { ...item, status: "in_progress", content: [] } : item,
  });
const responseEvent = (failed: boolean, attempt: number, output: OutputMessage[]) => {
  const status = failed ? "failed" : "completed";
  const input_tokens = failed ? 21 : 10;
  const output_tokens = failed ? 4 : 5;
  return encodeEvent({
    type: `response.${status}`,
    response: {
      id: failed ? `failure-${attempt}` : "fallback-response",
      status,
      output,
      usage: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens },
      ...(failed ? { error: { code: null, message: tokenGenerationError } } : {}),
    },
  });
};
const contains = (value: unknown) => expect.arrayContaining([expect.objectContaining(value)]);

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
  { timeout: 180_000 },
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
    let receiveTerminal: ((event: ChatEvent) => void) | undefined;
    const publishedMessages = new Map<string, unknown>();
    const fallbackAttempts: Array<{ runId: string; attempts: unknown }> = [];
    const provider = createServer((request, response) => {
      void (async () => {
        const reply = (value: unknown, status = 200, stream = false) => {
          response.writeHead(status, {
            "content-type": stream ? "text/event-stream" : "application/json",
          });
          response.end(stream ? encodeEvent(value) : JSON.stringify(value));
        };
        if (request.method === "GET" && request.url === "/v1/models") {
          reply({ data: [{ id: primaryModel }, { id: fallbackModel }] });
          return;
        }
        expect(request).toMatchObject({ method: "POST", url: "/v1/responses" });
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
          reply({ error }, rejection.status, rejection.status === undefined);
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const recovered = scenario === "continuation" && requests.length === 2;
        const failed = (payload.model === primaryModel && !recovered) || scenario === "exhausted";
        const item = outputMessage(
          failed ? `failed-${requests.length}` : "fallback",
          failed ? prefix : recovered ? continuation : marker,
        );
        const output = failed && scenario === "fallback" ? [] : [item];
        if (output.length) {
          response.write(itemEvent(item, true));
          if (failed) {
            response.write(
              encodeEvent({
                type: "response.output_text.delta",
                output_index: 0,
                item_id: item.id,
                content_index: 0,
                delta: prefix,
              }),
            );
          }
          response.write(itemEvent(item));
        }
        response.end(responseEvent(failed, requests.length, output));
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const address = provider.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback provider address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const providerConfig = (id: string) => ({
        baseUrl,
        apiKey: "test",
        api: "openai-responses" as const,
        models: [model(id)],
      });
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
                    fallbacks: name === "no-fallback" ? [] : [`openai/${fallbackModel}`],
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
          const { event: kind, payload } = event;
          if (kind === "chat") {
            const chatEvent = payload as ChatEvent;
            events.push(chatEvent);
            receiveTerminal?.(chatEvent);
          }
          if (!isRecord(payload)) {
            return;
          }
          if (
            kind === "session.message" &&
            typeof payload.sessionKey === "string" &&
            isRecord(payload.message) &&
            payload.message.role === "assistant"
          ) {
            publishedMessages.set(payload.sessionKey, payload.message);
          }
          if (
            kind === "agent" &&
            typeof payload.runId === "string" &&
            isRecord(payload.data) &&
            payload.data.phase === "fallback"
          ) {
            fallbackAttempts.push({ runId: payload.runId, attempts: payload.data.attempts });
          }
        },
      });
      const installed = getActivePluginRegistry()?.providers.find(
        (entry) => entry.provider.id === "xai",
      );
      expect(installed).toMatchObject({
        pluginId: "xai",
        provider: { classifyFailoverReason: expect.any(Function) },
      });
      for (const selected of scenarios) {
        scenario = selected;
        requests = [];
        const rejection = rejections.get(scenario);
        const sessionKey = `agent:${scenario}:xai-fallback`;
        await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
        const started = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Reply with the marker.",
          deliver: false,
          idempotencyKey: `xai-${scenario}`,
        });
        const terminalReceived = createDeferred();
        const expectsSuccess = selected !== "no-fallback" && selected !== "exhausted";
        receiveTerminal = (event: ChatEvent) => {
          if (
            event.runId === started.runId &&
            event.sessionKey === sessionKey &&
            (expectsSuccess
              ? event.state === "final" && event.stopReason === "stop"
              : event.state === "error")
          ) {
            terminalReceived.resolve();
          }
        };
        // The expected terminal may arrive before chat.send acknowledges its run ID.
        events.forEach(receiveTerminal);
        const completed = await gateway.client.request<{
          status: string;
          terminalReply?: { text?: string };
        }>("agent.wait", { runId: started.runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 });
        expect(completed.status, scenario).not.toBe("timeout");
        // Status-notice finals do not settle the transcript-gated successful reply.
        await withinTest(terminalReceived.promise, signal);
        receiveTerminal = undefined;
        const history = await gateway.client.request<{
          messages: Array<{ role: string; content: unknown; stopReason?: string }>;
        }>("chat.history", { sessionKey, limit: 20 });
        const assistant = history.messages.findLast((message) => message.role === "assistant");
        const runEvents = events.filter((event) => event.runId === started.runId);
        const check = (actual: unknown) => expect.soft(actual, scenario);
        check(requests[0]).toBe(primaryModel);
        check(requests.filter((requested) => requested === primaryModel)).toHaveLength(
          rejection && rejection.reason !== "rate_limit" ? 1 : 2,
        );
        const terminal = runEvents.filter(
          (event) => event.state === "final" && event.stopReason === "stop",
        );
        check(requests.includes(fallbackModel)).toBe(
          scenario !== "continuation" && scenario !== "no-fallback",
        );
        if (expectsSuccess) {
          const expected = scenario === "continuation" ? continuation : marker;
          check(completed).toMatchObject({
            status: "ok",
            terminalReply: { text: expected },
          });
          check(assistant).toMatchObject({ stopReason: "stop" });
          check(messageText(assistant)).toBe(expected);
          check(terminal).toHaveLength(1);
          check(messageText(terminal[0]?.message)).toBe(expected);
          if (rejection) {
            check(fallbackAttempts).toEqual(
              contains({
                runId: started.runId,
                attempts: contains({
                  provider: "xai",
                  model: primaryModel,
                  reason: rejection.reason,
                  ...(rejection.status === undefined ? {} : { status: rejection.status }),
                }),
              }),
            );
          }
        } else {
          check(completed.status).toBe("error");
          check(messageText(assistant)).toBe(prefix);
          check(messageText(publishedMessages.get(sessionKey))).toBe(prefix);
          const deltas = runEvents.filter((event) => event.state === "delta");
          const liveMessage = deltas.reduce<unknown>(
            (previous, event) => mergeChatStreamMessage(previous, event),
            undefined,
          );
          // Saved assistant content belongs to canonical publication, not the unsaved live tail.
          check(messageText(liveMessage)).toBe("");
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
