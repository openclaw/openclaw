/** Real Gateway reload/failover proof with final-request account and capability checks. */
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
import { anthropicTextTurn } from "./anthropic-text-turn.test-support.js";
import {
  listenLoopback,
  readRequestText,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { createSolidPngBuffer } from "./helpers/image-fixtures.js";
import { createDeferred } from "./helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const PROVIDER_ID = "mock-anthropic";
const PLUGIN_ID = "catalog-reload-proof";
const PRIMARY_MODEL_ID = "claude-opus-5";
const FALLBACK_MODEL_ID = "catalog-only-fallback";
const PRIMARY_REF = `${PROVIDER_ID}/${PRIMARY_MODEL_ID}`;
const FALLBACK_REF = `${PROVIDER_ID}/${FALLBACK_MODEL_ID}`;
const TOKEN = "pr154462-proof-token";
const REPLY_MARKER = "PR154462_TURN_COMPLETED_AFTER_REPLACEMENT";

const ACCOUNT_A = "fixture-account-a-v1";
const ACCOUNT_A_REFRESHED = "fixture-account-a-v2";
const ACCOUNT_B = "fixture-account-b";

function textTurn(model: string, text: string): string {
  return anthropicTextTurn(model, text, `msg_pr154462_${model}`, 320, 8);
}

function providerError(response: ServerResponse, status: number, type: string, message: string) {
  respondJson(response, { type: "error", error: { type, message } }, status);
}

function modelCapabilities(rich: boolean): Pick<ModelDefinitionConfig, "reasoning" | "input"> {
  return { reasoning: rich, input: rich ? ["text", "image"] : ["text"] };
}

const primaryModel: ModelDefinitionConfig = {
  id: PRIMARY_MODEL_ID,
  name: "Mock Claude Opus 5",
  api: "anthropic-messages",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};

type ProviderRequest = {
  model: string;
  credential: "A-original" | "A-refreshed" | "B" | "unknown";
  thinking: { type?: string; budget_tokens?: number } | null;
  imageCount: number;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it(
  "keeps admitted request facts across same-account refresh and same-route account replacement",
  { timeout: 120_000 },
  async () => {
    const tempHome = tempDirs.make("openclaw-config-reload-proof-");
    const stateDir = path.join(tempHome, ".openclaw");
    const workspaceDir = path.join(tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
    const fixtureEnv = {
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
    };
    const envSnapshot = captureEnv(Object.keys(fixtureEnv));
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
    const attachments = [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "sample.png",
        content: `data:image/png;base64,${image}`,
      },
    ];
    const expectRichRequest = (request: ProviderRequest) => {
      expect(request.credential).toBe("A-original");
      expect(request.imageCount).toBe(1);
      expect(request.thinking?.type).toMatch(/^(enabled|adaptive)$/);
      if (request.thinking?.type === "enabled") {
        expect(request.thinking.budget_tokens).toBeGreaterThan(0);
      }
      return { thinking: request.thinking, imageCount: request.imageCount };
    };
    let heldResponse: ServerResponse | undefined;
    let primaryHeld = createDeferred<ServerResponse>();
    let holdPrimary = false;
    let failPrimary = false;
    try {
      await Promise.all(
        [workspaceDir, bundledPluginsDir, stateDir].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      for (const [key, value] of Object.entries(fixtureEnv)) {
        setTestEnvValue(key, value);
      }
      const pluginDir = path.join(tempHome, "provider-plugin");
      const pluginFile = path.join(pluginDir, "index.mjs");
      await fs.mkdir(pluginDir, { recursive: true });
      for (const [file, content] of Object.entries({
        "openclaw.plugin.json": JSON.stringify({
          id: PLUGIN_ID,
          providers: [PROVIDER_ID],
          providerCatalogEntry: "./provider-discovery.mjs",
          modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
          configSchema: { type: "object", properties: {}, additionalProperties: false },
        }),
        "provider-discovery.mjs": `export default {
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
        "index.mjs": `import provider from "./provider-discovery.mjs";
          export default { id: ${JSON.stringify(PLUGIN_ID)}, register(api) { api.registerProvider(provider); } };`,
      })) {
        await fs.writeFile(path.join(pluginDir, file), content);
      }
      providerServer = createServer((request, response) => {
        const credential = identifyCredential(request.headers["x-api-key"]);
        if (credential === "unknown") {
          providerError(response, 401, "authentication_error", "unknown fixture account");
          return;
        }
        if (request.url === "/models") {
          catalogRequests.push(credential);
          const rich = credential !== "B";
          respondJson(response, {
            models: catalogModels.map((model) => Object.assign({}, model, modelCapabilities(rich))),
          });
          return;
        }
        void readRequestText(request).then((body) => {
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
            imageCount: (parsed.messages ?? [])
              .flatMap(({ content }) => (Array.isArray(content) ? content : []))
              .filter((part) => part.type === "image").length,
          });
          if (holdPrimary && model === PRIMARY_MODEL_ID) {
            holdPrimary = false;
            heldResponse = response;
            primaryHeld.resolve(response);
            return;
          }
          if (failPrimary && model === PRIMARY_MODEL_ID) {
            providerError(response, 404, "not_found_error", `model: ${model}`);
            return;
          }
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
          response.end(textTurn(model, model === FALLBACK_MODEL_ID ? REPLY_MARKER : "warmup-ok"));
        });
      });
      // The undeclared fallback must hydrate capabilities through the real catalog owner.
      const provider = {
        baseUrl: await listenLoopback(providerServer),
        apiKey: ACCOUNT_A,
        api: "anthropic-messages",
        models: [primaryModel] satisfies [ModelDefinitionConfig],
      } satisfies ModelProviderConfig;
      catalogModels = [
        ...provider.models,
        { ...provider.models[0], id: FALLBACK_MODEL_ID, name: "Discovered fallback" },
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
              model: { primary: PRIMARY_REF, fallbacks: [FALLBACK_REF] },
              thinkingDefault: "low",
            },
            entries: { main: {} },
          },
          models: { mode: "merge", providers: { [PROVIDER_ID]: provider } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        },
        configPath,
        token: TOKEN,
        clientDisplayName: "config-reload-proof",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        hotReloadRecovery: () => ({ status: "emitted" as const }),
      });
      const client = gateway.client;
      const boundedRequest = <T>(method: string, params: unknown) =>
        client.request<T>(method, params, { timeoutMs: 60_000 });
      const currentCatalog = () => {
        const owner = getPreparedModelCatalogOwnerSnapshot({ config: getRuntimeConfig() });
        return owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
      };
      const patchConfig = async (models: ModelProviderConfig) => {
        const before = await client.request<{ hash: string }>("config.get", {});
        const patched = await boundedRequest<{ hash?: string }>("config.patch", {
          baseHash: before.hash,
          replacePaths: [`models.providers.${PROVIDER_ID}.models[].input`],
          raw: JSON.stringify({ models: { providers: { [PROVIDER_ID]: models } } }),
        });
        expect(patched.hash).toEqual(expect.any(String));
      };
      const refreshCatalog = async (rich: boolean) => {
        const requestsBefore = catalogRequests.length;
        const committed = createDeferred<boolean>();
        const checkReady = () => {
          const catalog = currentCatalog();
          const model = catalog?.entries.find(
            (entry) => entry.provider === PROVIDER_ID && entry.id === FALLBACK_MODEL_ID,
          );
          const ready =
            catalogRequests.length > requestsBefore &&
            !catalog?.pendingProviders?.includes(PROVIDER_ID) &&
            model?.reasoning === rich &&
            model.input?.includes("image") === rich;
          if (ready) {
            committed.resolve(true);
          }
          return ready;
        };
        const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
          if (event.phase === "catalog-failed") {
            committed.resolve(false);
          } else if (event.phase === "catalog-published") {
            checkReady();
          }
        });
        try {
          await Promise.all([
            boundedRequest("models.list", {
              agentId: "main",
              provider: PROVIDER_ID,
              refresh: true,
            }).then(() => {
              const ready = checkReady();
              const catalog = currentCatalog();
              if (!ready && !catalog?.pendingProviders?.includes(PROVIDER_ID)) {
                throw new Error("Catalog refresh settled without the requested provider inventory");
              }
            }),
            committed.promise.then((published) => expect(published).toBe(true)),
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
      };
      const send = async (id: string, withImage = false) => {
        const started = await client.request<{ status?: string; runId?: string }>("chat.send", {
          sessionKey: `agent:main:${id}`,
          message: "Reply with a short answer.",
          deliver: false,
          idempotencyKey: id,
          ...(withImage ? { attachments } : {}),
        });
        expect(started.status).toBe("started");
        return started;
      };
      const waitForRun = async (runId: string | undefined) => {
        const result = await boundedRequest<{ status?: string }>("agent.wait", {
          runId,
          timeoutMs: 30_000,
        });
        expect(result).toMatchObject({ status: "ok" });
      };
      await waitForRun((await send("reload-warmup")).runId);
      await refreshCatalog(true);
      const beforeBaseline = requests.length;
      failPrimary = true;
      await waitForRun((await send("reload-baseline", true)).runId);
      failPrimary = false;
      const fallbackSince = (offset: number) =>
        requests.slice(offset).find((request) => request.model === FALLBACK_MODEL_ID);
      const baseline = fallbackSince(beforeBaseline);
      if (!baseline) {
        throw new Error("no fallback request in the no-reload control");
      }
      const admittedShape = expectRichRequest(baseline);
      const scenarios = [
        ["same-account-refresh", ACCOUNT_A_REFRESHED, "A-refreshed"],
        ["same-route-account-switch", ACCOUNT_B, "B"],
      ] as const;
      for (const [scenarioIndex, [name, replacementKey, nextCredential]] of scenarios.entries()) {
        if (scenarioIndex > 0) {
          await patchConfig(provider);
        }
        await refreshCatalog(true);
        const capturedConfig = getRuntimeConfig();
        const configuredOwner = getPreparedModelCatalogOwnerSnapshot({ config: capturedConfig });
        expect(configuredOwner).toBeDefined();
        const carriedFallback = configuredOwner?.modelCatalog.entries.find(
          (entry) => entry.provider === PROVIDER_ID && entry.id === FALLBACK_MODEL_ID,
        );
        expect(carriedFallback?.input?.includes("image") ?? false).toBe(false);
        primaryHeld = createDeferred<ServerResponse>();
        holdPrimary = true;
        failPrimary = false;
        heldResponse = undefined;
        const sessionKey = `agent:main:${name}`;
        const held = await send(name, true);
        const admittedResponse = await primaryHeld.promise;
        const richReplacement = replacementKey !== ACCOUNT_B;
        const replacement: ModelProviderConfig = {
          ...provider,
          apiKey: replacementKey,
          models: provider.models.map((model) =>
            Object.assign({}, model, modelCapabilities(richReplacement)),
          ),
        };
        await patchConfig(replacement);
        expect(getRuntimeConfig()).not.toBe(capturedConfig);
        expect(getPreparedModelCatalogOwnerSnapshot({ config: capturedConfig })).toBeUndefined();
        await refreshCatalog(richReplacement);
        expect(catalogRequests).toContain(nextCredential);
        const beforeFailover = requests.length;
        failPrimary = true;
        providerError(admittedResponse, 404, "not_found_error", `model: ${PRIMARY_MODEL_ID}`);
        await waitForRun(held.runId);
        const finalRequest = fallbackSince(beforeFailover);
        expect(finalRequest).toBeDefined();
        const shape = expectRichRequest(finalRequest!);
        expect(shape).toEqual(admittedShape);
        const history = await client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey,
          limit: 20,
        });
        expect(JSON.stringify(history.messages)).toContain(REPLY_MARKER);
        failPrimary = false;
        const beforeNewTurn = requests.length;
        await waitForRun((await send(`${name}-new`)).runId);
        expect(
          requests.slice(beforeNewTurn).find((request) => request.model === PRIMARY_MODEL_ID)
            ?.credential,
        ).toBe(nextCredential);
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
