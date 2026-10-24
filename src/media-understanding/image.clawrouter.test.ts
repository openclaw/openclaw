import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEmptyAgentDiscoveryStores } from "../agents/embedded-agent-runner/model.js";
import { createPreparedConfiguredRuntimeModelLookup } from "../agents/embedded-agent-runner/model.static-id.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { resolveImageRuntime } from "./image-model-runtime.js";

afterEach(() => clearLiveCatalogCacheForTests());

// Real catalog HTTP, model registry, auth resolution, and image eligibility gate.
// The prepared snapshot supplies already-discovered rows, not a second model policy.
it("admits ClawRouter native vision catalog rows and rejects text-only, malformed, and unknown rows", async () => {
  const { default: clawrouter } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  await withOpenClawTestState({ label: "clawrouter-image" }, async (state) => {
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const models = [
      { id: "openai/gpt-6.1-sol", upstream: "gpt-6.1-sol" },
      { id: "openai/gpt-6-astra", upstream: "gpt-6-astra" },
      { id: "openai/gpt-4.1", upstream: "gpt-4.1" },
      { id: "openai/declared-vision", upstream: "unknown", input: ["text", "image"] },
      { id: "openai/text-sol", upstream: "gpt-6.1-sol", input: ["text"] },
      { id: "openai/malformed-sol", upstream: "gpt-6.1-sol", input: ["image", {}] },
      { id: "openai/gpt-6-unknown", upstream: "gpt-6-unknown" },
    ];
    const listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              providers: [
                {
                  id: "openai",
                  displayName: "OpenAI",
                  openaiCompatible: true,
                  nativeBaseUrl: "/v1/native/openai",
                  routes: [],
                  models: models.map((model) =>
                    Object.assign(model, { capabilities: ["llm.responses"] }),
                  ),
                },
              ],
            }),
          );
        }),
    });
    try {
      const baseUrl = "http://127.0.0.1:" + listener.claim.port;
      const credential = "synthetic-clawrouter-image-key";
      const cfg: OpenClawConfig = {
        models: { providers: { clawrouter: { baseUrl, apiKey: credential, models: [] } } },
      };
      const provider = await registerSingleProviderPlugin(clawrouter);
      const catalog = await provider.catalog?.run({
        config: cfg,
        env: {},
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        resolveProviderAuth: () => ({
          apiKey: credential,
          discoveryApiKey: credential,
          mode: "api_key",
          source: "profile",
        }),
        resolveProviderApiKey: () => ({ apiKey: credential, discoveryApiKey: credential }),
      });
      if (!catalog || !("provider" in catalog) || !catalog.provider) {
        throw new Error("Expected a discovered ClawRouter provider");
      }
      expect(requests).toEqual([{ url: "/v1/catalog", authorization: "Bearer " + credential }]);
      const discovered = catalog.provider;
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const stores = createEmptyAgentDiscoveryStores();
      stores.modelRegistry = ModelRegistry.fromCapturedSources(
        stores.authStorage,
        join(state.agentDir(), "models.json"),
        {
          modelsJsonContents: null,
          pluginCatalogs: [],
          staticProviderConfigs: { clawrouter: discovered },
          pluginMetadataSnapshot: metadataSnapshot,
        },
      );
      const rows = stores.modelRegistry.getAll();
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers.push({
        pluginId: "clawrouter",
        source: "bundled-clawrouter-test",
        provider,
      });
      const configuredRuntimeModels = rows.map((model) => ({
        provider: "clawrouter",
        modelId: model.id,
        model,
      }));
      const snapshot: PreparedModelRuntimeSnapshot = {
        catalogOwner: undefined,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        activeProjectKeys: [],
        config: cfg,
        observationConfig: cfg,
        isCurrent: () => true,
        authModes: {},
        metadataSnapshot,
        pluginRegistry,
        allowGatewaySubagentBinding: false,
        modelCatalog: { entries: [], routeVariants: [] },
        configuredRuntimeModels,
        findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
          configuredRuntimeModels,
          metadataSnapshot,
        ),
        inlineProviderModels: [],
        createStores: () => stores,
      };
      const resolve = async (model: string, signal?: AbortSignal) => {
        let resources: AsyncDisposable | undefined;
        try {
          return await resolveImageRuntime(
            {
              cfg,
              agentDir: state.agentDir(),
              provider: "clawrouter",
              model,
              authStore: { version: 1, profiles: {} },
              preparedModelRuntime: snapshot,
              signal,
            },
            (acquired) => {
              resources = acquired;
            },
          );
        } finally {
          await resources?.[Symbol.asyncDispose]();
        }
      };
      for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-4.1", "declared-vision"]) {
        const runtime = await resolve("openai/" + id);
        expect(runtime.model).toMatchObject({
          provider: "clawrouter",
          id: "openai/" + id,
          api: "openai-responses",
          baseUrl: baseUrl + "/v1",
          input: ["text", "image"],
        });
        expect(runtime.runtimeValue).toBe(credential);
      }
      for (const id of ["text-sol", "malformed-sol", "gpt-6-unknown"]) {
        await expect(resolve("openai/" + id)).rejects.toThrow(
          "Model does not support images: clawrouter/openai/" + id,
        );
      }
      const cancelled = new Error("synthetic image cancellation");
      await expect(resolve("openai/gpt-6.1-sol", AbortSignal.abort(cancelled))).rejects.toBe(
        cancelled,
      );
      // Model setup/cancellation must not send inference or look up an upstream key.
      expect(requests).toHaveLength(1);
    } finally {
      await listener.releaseListener();
      await listener.claim.release();
    }
  });
});
