import fs from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  writeConfigFile,
} from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { redactSensitiveText } from "../logging/redact.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
} from "./gateway-provider-fixture.test-support.js";
import { createGatewayConfigPath, setupGatewayTempHome } from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

let sequence = 0;

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

describe("gateway compaction hot reload", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it(
    "applies hot-reloaded tool policy, context budgets, and compaction models without restarting",
    { timeout: 90_000 },
    async () => {
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-gw-compaction-hot-reload-",
      });
      const configPath = await createGatewayConfigPath(tempHome);
      const token = nextId("compaction-hot-reload-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);

      const providerRequests: string[] = [];
      const providerRequestToolNames: string[][] = [];
      const summaryByModel = new Map<string, string>();
      const providerServer = createServer((request, response) => {
        void (async () => {
          const raw = await readProviderBody(request);
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(raw) as {
            model?: string;
            tools?: Array<{ name?: string; function?: { name?: string } }>;
          };
          const model = body.model ?? "";
          providerRequests.push(model);
          providerRequestToolNames.push(
            body.tools?.map((tool) => tool.name ?? tool.function?.name ?? "") ?? [],
          );
          const text = summaryByModel.get(model) ?? "Primary assistant answer.";
          const message = {
            type: "message",
            id: nextId("provider-message"),
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [
            {
              type: "response.output_item.added",
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", item: message },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
              },
            },
          ]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        const baseUrl = await listenProvider(providerServer);
        const primaryModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-primary");
        const oldCompactionModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-old-summary");
        const newCompactionModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-new-summary");
        const availableModels = [primaryModel, oldCompactionModel, newCompactionModel];
        const modelDefaults = { params: { transport: "sse", openaiWsWarmup: false } };
        const newSummary = "HOT_RELOAD_COMPACTION_SUMMARY";
        summaryByModel.set(oldCompactionModel.modelId, "STALE_COMPACTION_SUMMARY");
        summaryByModel.set(newCompactionModel.modelId, newSummary);

        const initialConfig = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: primaryModel.modelRef },
              models: Object.fromEntries(
                availableModels.map(({ modelRef }) => [modelRef, modelDefaults]),
              ),
              compaction: {
                model: oldCompactionModel.modelRef,
                maxActiveTranscriptBytes: "1mb",
                keepRecentTokens: 1,
                recentTurnsPreserve: 1,
                qualityGuard: { enabled: false },
                memoryFlush: { enabled: false },
              },
            },
            entries: { dev: {} },
          },
          models: {
            mode: "replace",
            providers: {
              [primaryModel.providerId]: {
                ...primaryModel.config,
                models: Array.from(availableModels, ({ config }) => ({
                  ...config.models[0],
                  input: Array.from(config.models[0].input),
                })),
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg: initialConfig,
          configPath,
          token,
          clientDisplayName: "vitest-compaction-hot-reload",
        });
        const gatewayClient = gateway.client;
        const sessionKey = "agent:dev:main";
        const sessionId = nextId("existing-compaction-session");
        const scope = {
          agentId: "dev",
          sessionId,
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "dev" }),
        };
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: Date.now(),
          compactionCount: 0,
          modelProvider: primaryModel.providerId,
          model: primaryModel.modelId,
          totalTokens: 20,
          totalTokensFresh: true,
        });
        const persistedContext = "persisted conversation ".repeat(24);
        const durableContext = "durable model context ".repeat(24);
        for (let turn = 0; turn < 6; turn += 1) {
          const timestamp = Date.now() + turn;
          await appendTranscriptMessage(scope, {
            message: {
              role: "user",
              content: `Historical request ${turn}: ${persistedContext}`,
              timestamp,
            },
          });
          await appendTranscriptMessage(scope, {
            message: {
              role: "assistant",
              content: [{ type: "text", text: `Historical answer ${turn}: ${durableContext}` }],
              api: "openai-responses",
              provider: primaryModel.providerId,
              model: primaryModel.modelId,
              usage: {
                input: 10,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 20,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp,
            },
          });
        }
        expect(loadTranscriptEventsSync(scope).length).toBeGreaterThan(10);

        const sendChatAndWait = async (message: string) => {
          const started = await gatewayClient.request<{ runId: string; status: string }>(
            "chat.send",
            { sessionKey, message, idempotencyKey: nextId("compaction-chat") },
          );
          expect(started.status).toBe("started");
          const completed = await gatewayClient.request<AgentWaitResult>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          const diagnostic = redactSensitiveText(JSON.stringify(completed), { mode: "tools" })
            .replaceAll(token, "[test-token]")
            .replaceAll(tempHome, "[test-home]")
            .slice(0, 4_000);
          expect(completed.status, diagnostic).toBe("ok");
        };

        await sendChatAndWait("Warm the existing prepared model runtime.");
        expect(providerRequests).toContain(primaryModel.modelId);
        expect(providerRequestToolNames.at(-1)).toContain("exec");
        expect(loadSessionEntry(scope)?.compactionCount ?? 0).toBe(0);

        const reloadedTools = { deny: ["exec"] };
        await writeConfigFile({ ...initialConfig, tools: reloadedTools });
        await expect
          .poll(() => getRuntimeConfig().tools?.deny, { timeout: 5_000, interval: 50 })
          .toEqual(["exec"]);
        await sendChatAndWait("Apply the hot-reloaded tool deny policy to the existing runtime.");
        expect(providerRequestToolNames.at(-1)).not.toContain("exec");

        await writeConfigFile({
          ...initialConfig,
          agents: {
            ...initialConfig.agents,
            defaults: {
              ...initialConfig.agents.defaults,
              compaction: {
                ...initialConfig.agents.defaults.compaction,
                model: newCompactionModel.modelRef,
                maxActiveTranscriptBytes: "10b",
              },
            },
          },
          tools: reloadedTools,
        });
        await expect
          .poll(() => getRuntimeConfig().agents?.defaults?.compaction, {
            timeout: 5_000,
            interval: 50,
          })
          .toMatchObject({ model: newCompactionModel.modelRef, maxActiveTranscriptBytes: "10b" });

        const requestsBeforeCompaction = providerRequests.length;
        await sendChatAndWait("Compact the existing conversation before answering.");

        const newRequests = providerRequests.slice(requestsBeforeCompaction);
        expect(newRequests).toContain(newCompactionModel.modelId);
        expect(newRequests).not.toContain(oldCompactionModel.modelId);
        expect(loadSessionEntry(scope)?.compactionCount).toBe(1);
        expect(loadTranscriptEventsSync(scope)).toContainEqual(
          expect.objectContaining({
            type: "compaction",
            summary: expect.stringContaining(newSummary),
          }),
        );
        await expect(gatewayClient.request("health", {})).resolves.toEqual(expect.any(Object));
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "compaction hot reload integration test complete" });
        }
        await closeProvider(providerServer);
        await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        envSnapshot.restore();
      }
    },
  );
});
