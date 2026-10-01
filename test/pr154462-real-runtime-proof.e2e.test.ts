/** Real Gateway reload/failover proof with final-request account and capability checks. */
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPreparedModelCatalogOwnerSnapshot,
  loadProviderScopedThinkingCatalog,
} from "../src/agents/prepared-model-catalog.js";
import { registerPreparedModelRuntimePublicationListener } from "../src/agents/prepared-model-runtime.publication-events.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { createSolidPngBuffer } from "./helpers/image-fixtures.js";
import { createDeferred } from "./helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const PROVIDER_ID = "mock-anthropic";
const PLUGIN_ID = "catalog-reload-proof";
const PRIMARY_MODEL_ID = "claude-opus-5";
const FALLBACK_MODEL_ID = "catalog-only-fallback";
const TOKEN = "pr154462-proof-token";
const REPLY_MARKER = "PR154462_TURN_COMPLETED_AFTER_REPLACEMENT";

const ACCOUNT_A = "fixture-account-a-v1";
const ACCOUNT_A_REFRESHED = "fixture-account-a-v2";
const ACCOUNT_B = "fixture-account-b";

const epoch = performance.now();
function proof(event: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      proof: true,
      event,
      utc: new Date().toISOString(),
      ms: Number((performance.now() - epoch).toFixed(1)),
      pid: process.pid,
      ...data,
    }),
  );
}

function anthropicSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/** A plain streamed text answer attributed to the requested model. */
function textTurn(model: string, text: string): string {
  return anthropicSse([
    {
      type: "message_start",
      message: {
        id: `msg_pr154462_${model}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 320, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ]);
}

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: PRIMARY_MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  // The fallback model is deliberately NOT declared: with no authored row and no carried
  // catalog entry, the failover's resolveRunModelHasVision read must hydrate its
  // capabilities through loadProviderScopedThinkingCatalog on the real turn path.
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: ACCOUNT_A,
    api: "anthropic-messages",
    models: [model],
  };
  return {
    providerId: PROVIDER_ID,
    primaryRef: `${PROVIDER_ID}/${PRIMARY_MODEL_ID}`,
    fallbackRef: `${PROVIDER_ID}/${FALLBACK_MODEL_ID}`,
    config,
  } as const;
}

type ProviderRequest = {
  model: string;
  credential: "A-original" | "A-refreshed" | "B" | "unknown";
  thinking: { type?: string; budget_tokens?: number } | null;
  imageCount: number;
};

describe("runtime-config replacement during a turn", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it(
    "keeps admitted request facts across same-account refresh and same-route account replacement",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const requests: ProviderRequest[] = [];
      const catalogRequests: ProviderRequest["credential"][] = [];
      let catalogModels: ModelDefinitionConfig[] = [];
      const identifyCredential = (key: unknown): ProviderRequest["credential"] =>
        key === ACCOUNT_A
          ? "A-original"
          : key === ACCOUNT_A_REFRESHED
            ? "A-refreshed"
            : key === ACCOUNT_B
              ? "B"
              : "unknown";
      const image = createSolidPngBuffer(8, 8, { r: 40, g: 100, b: 180 }).toString("base64");
      const expectRichRequest = (request: ProviderRequest) => {
        expect(request.imageCount).toBe(1);
        expect(request.thinking?.type).toMatch(/^(enabled|adaptive)$/);
        if (request.thinking?.type === "enabled") {
          expect(request.thinking.budget_tokens).toBeGreaterThan(0);
        }
      };
      let heldResponse: ServerResponse | undefined;
      let onPrimaryHeld: (response: ServerResponse) => void = () => {};
      let holdPrimary = false;
      let failPrimary = false;
      try {
        const tempHome = tempDirs.make("openclaw-config-reload-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(stateDir, { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }
        const pluginDir = path.join(tempHome, "provider-plugin");
        const pluginFile = path.join(pluginDir, "index.mjs");
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: PLUGIN_ID,
            providers: [PROVIDER_ID],
            providerCatalogEntry: "./provider-discovery.mjs",
            modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "provider-discovery.mjs"),
          `export default {
            id: ${JSON.stringify(PROVIDER_ID)}, label: "Reload proof provider", auth: [],
            catalog: { order: "simple", async run(ctx) {
              const configured = ctx.config.models.providers[${JSON.stringify(PROVIDER_ID)}];
              const auth = ctx.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)});
              const key = auth.discoveryApiKey ?? auth.apiKey;
              if (!key) throw new Error("Fixture catalog has no materialized credential");
              const response = await fetch(configured.baseUrl + "/models", {
                headers: { "x-api-key": key }, signal: ctx.signal,
              });
              if (!response.ok) throw new Error("Fixture catalog authentication failed");
              const result = await response.json();
              return { provider: { ...configured, models: result.models } };
            } },
          };`,
        );
        await fs.writeFile(
          pluginFile,
          `import provider from "./provider-discovery.mjs";
          export default { id: ${JSON.stringify(PLUGIN_ID)}, register(api) { api.registerProvider(provider); } };`,
        );
        providerServer = createServer((request, response) => {
          const credential = identifyCredential(request.headers["x-api-key"]);
          if (credential === "unknown") {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                type: "error",
                error: { type: "authentication_error", message: "unknown fixture account" },
              }),
            );
            return;
          }
          if (request.url === "/models") {
            catalogRequests.push(credential);
            const rich = credential !== "B";
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                models: catalogModels.map((model) =>
                  Object.assign({}, model, {
                    reasoning: rich,
                    input: rich ? ["text", "image"] : ["text"],
                  } satisfies Pick<ModelDefinitionConfig, "reasoning" | "input">),
                ),
              }),
            );
            return;
          }
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const parsed = JSON.parse(body) as {
              model?: string;
              thinking?: ProviderRequest["thinking"];
              messages?: Array<{ content?: string | Array<{ type?: string }> }>;
            };
            const model = parsed.model ?? "";
            requests.push({
              model,
              credential,
              thinking: parsed.thinking ?? null,
              imageCount: (parsed.messages ?? []).reduce(
                (count, message) =>
                  count +
                  (Array.isArray(message.content)
                    ? message.content.filter((part) => part.type === "image").length
                    : 0),
                0,
              ),
            });
            if (holdPrimary && model === PRIMARY_MODEL_ID) {
              holdPrimary = false;
              heldResponse = response;
              onPrimaryHeld(response);
              return;
            }
            if (failPrimary && model === PRIMARY_MODEL_ID) {
              response.writeHead(404, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  type: "error",
                  error: { type: "not_found_error", message: `model: ${model}` },
                }),
              );
              return;
            }
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            response.end(textTurn(model, model === FALLBACK_MODEL_ID ? REPLY_MARKER : "warmup-ok"));
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer!.once("error", reject);
          providerServer!.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("loopback provider did not bind");
        }
        const provider = buildMockAnthropicProvider(`http://127.0.0.1:${address.port}`);
        catalogModels = [
          ...provider.config.models,
          { ...provider.config.models[0], id: FALLBACK_MODEL_ID, name: "Discovered fallback" },
        ];
        gateway = await startGatewayWithClient({
          cfg: {
            plugins: {
              allow: [PLUGIN_ID],
              load: { paths: [pluginFile] },
              entries: { [PLUGIN_ID]: { enabled: true } },
            },
            agents: {
              defaults: {
                workspace: workspaceDir,
                skipBootstrap: true,
                model: { primary: provider.primaryRef, fallbacks: [provider.fallbackRef] },
                thinkingDefault: "low",
              },
              entries: { main: { default: true } },
            },
            models: { mode: "merge", providers: { [PROVIDER_ID]: provider.config } },
            gateway: { auth: { mode: "token", token: TOKEN } },
          },
          configPath,
          token: TOKEN,
          clientDisplayName: "config-reload-proof",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          hotReloadRecovery: () => ({ status: "emitted" as const }),
        });
        const client = gateway.client;
        const patchConfig = async (models: ModelProviderConfig) => {
          const before = await client.request<{ hash: string }>("config.get", {});
          const patched = await client.request<{ hash?: string }>(
            "config.patch",
            {
              baseHash: before.hash,
              replacePaths: [`models.providers.${PROVIDER_ID}.models[].input`],
              raw: JSON.stringify({ models: { providers: { [PROVIDER_ID]: models } } }),
            },
            { timeoutMs: 60_000 },
          );
          expect(patched.hash).toEqual(expect.any(String));
        };
        const refreshCatalog = async (rich: boolean) => {
          const requestsBefore = catalogRequests.length;
          const committed = createDeferred<void>();
          const checkReady = () => {
            const owner = getPreparedModelCatalogOwnerSnapshot({ config: getRuntimeConfig() });
            const catalog = owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
            const model = catalog?.entries.find(
              (entry) => entry.provider === PROVIDER_ID && entry.id === FALLBACK_MODEL_ID,
            );
            const ready =
              catalogRequests.length > requestsBefore &&
              !catalog?.pendingProviders?.includes(PROVIDER_ID) &&
              model?.reasoning === rich &&
              model.input?.includes("image") === rich;
            if (ready) {
              committed.resolve();
            }
            return ready;
          };
          const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
            if (event.phase === "catalog-failed") {
              committed.reject(event.error);
            } else if (event.phase === "catalog-published") {
              checkReady();
            }
          });
          try {
            await Promise.all([
              client
                .request(
                  "models.list",
                  { agentId: "main", provider: PROVIDER_ID, refresh: true },
                  { timeoutMs: 60_000 },
                )
                .then(() => {
                  const ready = checkReady();
                  const owner = getPreparedModelCatalogOwnerSnapshot({
                    config: getRuntimeConfig(),
                  });
                  const catalog = owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
                  proof("catalog_refresh_observed", {
                    rich,
                    ready,
                    requests: [...catalogRequests],
                    pending: catalog?.pendingProviders ?? [],
                    entries: catalog?.entries.length ?? 0,
                  });
                  if (!ready && !catalog?.pendingProviders?.includes(PROVIDER_ID)) {
                    throw new Error(
                      "Catalog refresh settled without the requested provider inventory",
                    );
                  }
                }),
              committed.promise,
            ]);
          } finally {
            unsubscribe();
          }
          const facts = await loadProviderScopedThinkingCatalog({
            config: getRuntimeConfig(),
            provider: PROVIDER_ID,
            model: FALLBACK_MODEL_ID,
          });
          expect(facts).toContainEqual(
            expect.objectContaining({
              id: FALLBACK_MODEL_ID,
              reasoning: rich,
              input: rich ? ["text", "image"] : ["text"],
            }),
          );
          proof("catalog_ready", { credential: catalogRequests.at(-1), rich });
        };
        const send = async (sessionKey: string, id: string, withImage = false) => {
          const started = await client.request<{ status?: string; runId?: string }>("chat.send", {
            sessionKey,
            message: "Reply with a short answer.",
            deliver: false,
            idempotencyKey: id,
            ...(withImage
              ? {
                  attachments: [
                    {
                      type: "image",
                      mimeType: "image/png",
                      fileName: "sample.png",
                      content: `data:image/png;base64,${image}`,
                    },
                  ],
                }
              : {}),
          });
          expect(started.status).toBe("started");
          return started;
        };
        const waitForRun = async (runId: string | undefined) => {
          const result = await client.request<{ status?: string }>(
            "agent.wait",
            { runId, timeoutMs: 30_000 },
            { timeoutMs: 60_000 },
          );
          expect(result).toMatchObject({ status: "ok" });
        };
        await waitForRun((await send("agent:main:reload-warmup", "reload-warmup")).runId);
        await refreshCatalog(true);
        const beforeBaseline = requests.length;
        failPrimary = true;
        await waitForRun((await send("agent:main:reload-baseline", "reload-baseline", true)).runId);
        failPrimary = false;
        const baseline = requests
          .slice(beforeBaseline)
          .find((request) => request.model === FALLBACK_MODEL_ID);
        if (!baseline) {
          throw new Error("no fallback request in the no-reload control");
        }
        expect(baseline.credential).toBe("A-original");
        expectRichRequest(baseline);
        const admittedShape = { thinking: baseline.thinking, imageCount: baseline.imageCount };
        proof("baseline_request_verified", { credential: baseline.credential, ...admittedShape });
        const scenarios = [
          {
            name: "same-account-refresh",
            replacementKey: ACCOUNT_A_REFRESHED,
            nextCredential: "A-refreshed",
          },
          { name: "same-route-account-switch", replacementKey: ACCOUNT_B, nextCredential: "B" },
        ] as const;
        for (const [scenarioIndex, scenario] of scenarios.entries()) {
          if (scenarioIndex > 0) {
            await patchConfig(provider.config);
          }
          await refreshCatalog(true);
          const capturedConfig = getRuntimeConfig();
          const configuredOwner = getPreparedModelCatalogOwnerSnapshot({ config: capturedConfig });
          expect(configuredOwner).toBeDefined();
          const carriedFallback = configuredOwner?.modelCatalog.entries.find(
            (entry) => entry.provider === PROVIDER_ID && entry.id === FALLBACK_MODEL_ID,
          );
          expect(carriedFallback?.input?.includes("image") ?? false).toBe(false);
          const primaryHeld = new Promise<ServerResponse>((resolve) => {
            onPrimaryHeld = resolve;
          });
          holdPrimary = true;
          failPrimary = false;
          heldResponse = undefined;
          const sessionKey = `agent:main:${scenario.name}`;
          const held = await send(sessionKey, scenario.name, true);
          const admittedResponse = await primaryHeld;
          const richReplacement = scenario.replacementKey !== ACCOUNT_B;
          const replacement: ModelProviderConfig = {
            ...provider.config,
            apiKey: scenario.replacementKey,
            models: provider.config.models.map((model) =>
              Object.assign({}, model, {
                reasoning: richReplacement,
                input: richReplacement ? ["text", "image"] : ["text"],
              } satisfies Pick<ModelDefinitionConfig, "reasoning" | "input">),
            ),
          };
          await patchConfig(replacement);
          const replacementConfig = getRuntimeConfig();
          expect(replacementConfig).not.toBe(capturedConfig);
          expect(getPreparedModelCatalogOwnerSnapshot({ config: capturedConfig })).toBeUndefined();
          await refreshCatalog(richReplacement);
          expect(catalogRequests).toContain(scenario.nextCredential);
          const beforeFailover = requests.length;
          failPrimary = true;
          admittedResponse.writeHead(404, { "content-type": "application/json" });
          admittedResponse.end(
            JSON.stringify({
              type: "error",
              error: { type: "not_found_error", message: `model: ${PRIMARY_MODEL_ID}` },
            }),
          );
          await waitForRun(held.runId);
          const finalRequest = requests
            .slice(beforeFailover)
            .find((request) => request.model === FALLBACK_MODEL_ID);
          expect(finalRequest).toBeDefined();
          expect(finalRequest!.credential).toBe("A-original");
          expectRichRequest(finalRequest!);
          const shape = { thinking: finalRequest!.thinking, imageCount: finalRequest!.imageCount };
          expect(shape).toEqual(admittedShape);
          const history = await client.request<{ messages?: unknown[] }>("chat.history", {
            sessionKey,
            limit: 20,
          });
          expect(JSON.stringify(history.messages)).toContain(REPLY_MARKER);
          failPrimary = false;
          const beforeNewTurn = requests.length;
          await waitForRun(
            (await send(`agent:main:${scenario.name}-new`, `${scenario.name}-new`)).runId,
          );
          expect(
            requests.slice(beforeNewTurn).find((request) => request.model === PRIMARY_MODEL_ID)
              ?.credential,
          ).toBe(scenario.nextCredential);
          proof("final_request_verified", {
            scenario: scenario.name,
            admittedCredential: finalRequest!.credential,
            nextTurnCredential: scenario.nextCredential,
            ...shape,
            persistedReply: true,
          });
        }
      } finally {
        heldResponse?.destroy();
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer!.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
