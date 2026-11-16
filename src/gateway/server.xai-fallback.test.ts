import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import {
  replayChatDisplay,
  type ChatDisplayFrame,
} from "../../test/helpers/gateway/chat-display-replay.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedPluginModelCatalogs } from "../agents/plugin-model-catalog-execution.js";
import * as catalogWorker from "../agents/prepared-model-catalog-worker.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import * as backoff from "../infra/backoff.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import * as sharingAuthorization from "./session-sharing-authorization-async.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import type {
  PreparedSessionSourceFacts,
  SessionFactsRead,
} from "./session-sharing-target.types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildOpenAiResponsesTestModel } from "./test-openai-responses-model.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
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
    reason: "auth" | "billing" | "rate_limit" | "server_error";
  }
>([
  ...[400, 401, 403, 404, 410, 422].map(
    (status) => [`auth-${status}`, { status, message: authError, reason: "auth" }] as const,
  ),
  ["auth-code", { code: "credential_rejected", message: authError, reason: "auth" }],
  ["auth-type", { type: "upstream_error", message: authError, reason: "auth" }],
  ["auth-text", { message: authError, reason: "auth" }],
  [
    "token-generation-event",
    { type: "error", message: tokenGenerationError, reason: "server_error" },
  ],
  ["auth-event", { type: "error", message: authError, reason: "auth" }],
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
const encodeEvent = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const responseMessage = (id: string, text: string) => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

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
  async ({ signal }) => {
    // Retry timing is covered by the retry owner; keep Gateway I/O timers real.
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (_, sig) => sig?.throwIfAborted());
    const root = tempDirs.make("openclaw-xai-fallback-");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const discoveryStarted = createDeferred();
    const releaseDiscovery = createDeferred();
    const discoveryCompleted = createDeferred();
    void discoveryCompleted.promise.catch(() => {});
    let fallbackCatalogLoads = 0;
    const createWorker = catalogWorker.createPreparedModelCatalogWorker;
    vi.spyOn(catalogWorker, "createPreparedModelCatalogWorker").mockImplementation((params) => {
      const worker = createWorker(params);
      if (params.agentFacts.input.agentId !== "fallback") {
        return worker;
      }
      return {
        ...worker,
        async loadCatalog(...args: Parameters<typeof worker.loadCatalog>) {
          fallbackCatalogLoads += 1;
          discoveryStarted.resolve();
          // Hold discovery before its network budget starts; static Gateway readiness must proceed.
          await releaseDiscovery.promise;
          try {
            const catalog = await worker.loadCatalog(...args);
            discoveryCompleted.resolve();
            return catalog;
          } catch (error) {
            discoveryCompleted.reject(error);
            throw error;
          }
        },
      };
    });
    const authorize = sharingAuthorization.resolveSessionMutationAuthorizationAsync;
    vi.spyOn(sharingAuthorization, "resolveSessionMutationAuthorizationAsync").mockImplementation(
      async (params) => {
        const result = await authorize(params);
        if (
          params.method === "chat.send" &&
          isRecord(params.requestParams) &&
          params.requestParams.sessionKey === "agent:fallback:xai-fallback" &&
          params.requestParams.idempotencyKey === "xai-fallback"
        ) {
          try {
            expect(result.error).toBeNull();
            expect(result.authorization).toBeDefined();
            await withinTest(discoveryStarted.promise, signal);
            expect(fallbackCatalogLoads).toBe(1);
            releaseDiscovery.resolve();
            // Publish the real saved catalog while the request retains its original session facts.
            await withinTest(discoveryCompleted.promise, signal);
            expect(fallbackCatalogLoads).toBe(1);
          } catch (error) {
            result.authorization?.release?.();
            throw error;
          }
        }
        return result;
      },
    );
    let negativeWitness: SessionFactsRead<PreparedSessionSourceFacts> | undefined;
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
    let scenario = "fallback";
    let requests: string[] = [];
    const events: ChatEvent[] = [];
    const displayFrames: ChatDisplayFrame[] = [];
    const terminalEvents = new Map<string, (event: ChatEvent) => void>();
    const lastPublishedMessages = new Map<string, unknown>();
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
        if (payload.model === primaryModel && rejection && rejection.type !== "error") {
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
        const writeEvent = (type: string, data: Record<string, unknown>) =>
          response.write(encodeEvent({ type, ...data }));
        const recovered = scenario === "continuation" && requests.length === 2;
        if ((payload.model === primaryModel && !recovered) || scenario === "exhausted") {
          const item = responseMessage(`failed-${requests.length}`, prefix);
          if (scenario !== "fallback") {
            writeEvent("response.output_item.added", {
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            });
            writeEvent("response.output_text.delta", {
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              delta: prefix,
            });
            writeEvent("response.output_item.done", { output_index: 0, item });
          }
          response.end(
            encodeEvent(
              rejection?.type === "error"
                ? {
                    type: "error",
                    code: null,
                    sequence_number: 2,
                    message: rejection.message,
                  }
                : {
                    type: "response.failed",
                    response: {
                      id: `failure-${requests.length}`,
                      status: "failed",
                      error: { code: null, message: tokenGenerationError },
                      output: scenario === "fallback" ? [] : [item],
                      usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
                    },
                  },
            ),
          );
          return;
        }
        const message = responseMessage("fallback", recovered ? continuation : marker);
        response.end(
          [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", output_index: 0, item: message },
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
              xai: {
                baseUrl,
                apiKey: "test",
                api: "openai-responses",
                // The fixture's full prompt/tool surface estimates 18k tokens.
                models: [buildOpenAiResponsesTestModel(primaryModel, 128_000, 256)],
              },
              openai: {
                baseUrl,
                apiKey: "test",
                api: "openai-responses",
                models: [buildOpenAiResponsesTestModel(fallbackModel, 128_000, 256)],
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
            const chatEvent = event.payload as ChatEvent;
            events.push(chatEvent);
            displayFrames.push({ event: "chat", payload: chatEvent });
            terminalEvents.get(chatEvent.runId)?.(chatEvent);
          }
          if (event.event === "session.message") {
            displayFrames.push({ event: "session.message", payload: event.payload });
          }
          if (
            event.event === "session.message" &&
            isRecord(event.payload) &&
            typeof event.payload.sessionKey === "string" &&
            isRecord(event.payload.message) &&
            event.payload.message.role === "assistant"
          ) {
            lastPublishedMessages.set(event.payload.sessionKey, event.payload.message);
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
      negativeWitness = await prepareSessionMutationFacts({
        cfg: getRuntimeConfig(),
        sessionKey: "agent:fallback:xai-fallback",
        agentId: "fallback",
        allowMissing: true,
      });
      expect(negativeWitness.readCurrent(getRuntimeConfig()).target).toBeNull();
      for (const selected of scenarios) {
        scenario = selected;
        const check = (actual: unknown) => expect.soft(actual, scenario);
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
        const receiveTerminal = (event: ChatEvent) => {
          if (
            event.sessionKey === sessionKey &&
            ((event.state === "final" && event.stopReason === "stop") || event.state === "error")
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
        if (scenario === "fallback") {
          // A separate negative reader must still reject the real session creation.
          expect(() => negativeWitness!.readCurrent(getRuntimeConfig())).toThrow(
            SessionMutationFactsUnavailableError,
          );
          const catalogs = await loadPersistedPluginModelCatalogs(
            path.join(state, "agents", "fallback", "agent"),
            ["xai"],
          );
          expect(catalogs.find(({ pluginId }) => pluginId === "xai")?.contents).toContain(
            primaryModel,
          );
        }
        const assistant = history.messages.findLast((message) => message.role === "assistant");
        const runEvents = events.filter((event) => event.runId === started.runId);
        check(requests[0]).toBe(primaryModel);
        check(requests.filter((requested) => requested === primaryModel)).toHaveLength(
          rejection && rejection.reason !== "rate_limit" && rejection.reason !== "server_error"
            ? 1
            : 2,
        );
        const terminal = runEvents
          .filter((event) => event.state === "final")
          .filter((event) => event.stopReason === "stop");
        if (rejection || ["fallback", "continuation", "visible-fallback"].includes(scenario)) {
          const expected = scenario === "continuation" ? continuation : marker;
          if (scenario === "continuation") {
            check(requests).not.toContain(fallbackModel);
          } else {
            check(requests).toContain(fallbackModel);
          }
          check(completed.status).toBe("ok");
          check(assistant?.stopReason).toBe("stop");
          check(messageText(assistant)).toBe(expected);
          check(completed.terminalReply?.text).toBe(expected);
          check(terminal).toHaveLength(1);
          check(messageText(terminal[0]?.message)).toBe(expected);
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
        } else {
          check(completed.status).toBe("error");
          check(messageText(assistant)).toBe(prefix);
          check(messageText(lastPublishedMessages.get(sessionKey))).toBe(prefix);
          const display = replayChatDisplay(displayFrames, sessionKey, started.runId);
          check(display.chatRunId).toBeNull();
          check(display.chatStream).toBeNull();
          check(display.chatStreamSegments).toEqual([]);
          check(
            display.chatMessages
              .filter(isRecord)
              .filter((message) => message.role === "assistant")
              .map(messageText),
          ).toEqual(
            history.messages.filter((message) => message.role === "assistant").map(messageText),
          );
          if (scenario === "no-fallback") {
            check(requests).not.toContain(fallbackModel);
          } else {
            check(requests).toContain(fallbackModel);
          }
        }
      }
    } finally {
      releaseDiscovery.resolve();
      negativeWitness?.release();
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
