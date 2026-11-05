import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import {
  createGatewayConfigPath,
  nextGatewayId as nextId,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

describe("gateway compaction hot reload", () => {
  beforeEach(resetGatewayTestState);
  afterEach(resetGatewayTestState);

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
      const providerServer = createTrackedProvider((raw, response, request) => {
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
        writeOpenAiResponsesText(response, {
          text: summaryByModel.get(model) ?? "Primary assistant answer.",
          messageId: nextId("provider-message"),
          responseId: nextId("provider-response"),
        });
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        const baseUrl = await providerServer.listen();
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
        const chat = (message: string) => sendChatAndWait(gatewayClient, sessionKey, message);
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

        await chat("Warm the existing prepared model runtime.");
        expect(providerRequests).toContain(primaryModel.modelId);
        expect(providerRequestToolNames.at(-1)).toContain("exec");
        expect(loadSessionEntry(scope)?.compactionCount ?? 0).toBe(0);

        const reloadedTools = { deny: ["exec"] };
        await writeConfigFile({ ...initialConfig, tools: reloadedTools });
        await expect
          .poll(() => getRuntimeConfig().tools?.deny, { timeout: 5_000, interval: 50 })
          .toEqual(["exec"]);
        await chat("Apply the hot-reloaded tool deny policy to the existing runtime.");
        expect(providerRequestToolNames.at(-1)).not.toContain("exec");

        const reloadedConfig = { ...structuredClone(initialConfig), tools: reloadedTools };
        Object.assign(reloadedConfig.agents.defaults.compaction, {
          model: newCompactionModel.modelRef,
          maxActiveTranscriptBytes: "10b",
        });
        await writeConfigFile(reloadedConfig);
        await expect
          .poll(() => getRuntimeConfig().agents?.defaults?.compaction, {
            timeout: 5_000,
            interval: 50,
          })
          .toMatchObject({ model: newCompactionModel.modelRef, maxActiveTranscriptBytes: "10b" });

        const requestsBeforeCompaction = providerRequests.length;
        await chat("Compact the existing conversation before answering.");

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
        await providerServer.close();
        await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        envSnapshot.restore();
      }
    },
  );
});
