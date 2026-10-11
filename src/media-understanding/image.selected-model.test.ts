import { describe, expect, it, vi } from "vitest";
import { createEmptyAgentDiscoveryStores } from "../agents/embedded-agent-runner/model.js";
import { createPreparedConfiguredRuntimeModelLookup } from "../agents/embedded-agent-runner/model.static-id.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveImageRuntime } from "./image-model-runtime.js";

const provider = "image-selected-model";
const baseUrl = "https://image-selected-model.example/v1";

describe("image model selection ownership", () => {
  it("uses supplied alias metadata exactly once despite conflicting ambient hooks", async () => {
    await withOpenClawTestState({ label: "image-selected-model" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        models: {
          providers: {
            [provider]: {
              baseUrl,
              apiKey: "synthetic-fixture",
              models: [],
            },
          },
        },
      };
      await state.writeConfig(cfg);
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: provider,
            providers: [provider],
            modelIdNormalization: {
              providers: {
                [provider]: {
                  aliases: { entry: "middle", middle: "final", hooked: "wrong" },
                },
              },
            },
          },
        ],
      });
      const ambientMetadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: provider,
            providers: [provider],
            modelIdNormalization: {
              providers: { [provider]: { aliases: { entry: "wrong" } } },
            },
          },
        ],
      });
      const normalizeModelId = vi.fn(({ modelId }: { modelId: string }) =>
        modelId === "middle" ? "hooked" : modelId,
      );
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers.push({
        pluginId: provider,
        source: "synthetic-image-provider",
        provider: { id: provider, label: provider, auth: [], normalizeModelId },
      });
      const stores = createEmptyAgentDiscoveryStores();
      const rows = ["final", "middle", "plain", "hooked", "wrong"].map((id) =>
        Object.assign(
          makeProviderModelFixture({
            provider,
            id,
            api: "openai-completions",
            baseUrl,
            input: ["text", "image"],
          }),
          { contextWindow: 16_000, maxTokens: 4_096 },
        ),
      );
      stores.modelRegistry.registerProvider(provider, {
        api: "openai-completions",
        baseUrl,
        models: rows,
      });
      const configuredRuntimeModels = rows.map((model) => ({
        provider,
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
      const run = async () => {
        let runtimeResources: AsyncDisposable | undefined;
        try {
          const runtime = await resolveImageRuntime(
            {
              cfg,
              agentDir: state.agentDir(),
              provider,
              model: "entry",
              authStore: { version: 1, profiles: {} },
              preparedModelRuntime: snapshot,
            },
            (resources) => {
              runtimeResources = resources;
            },
          );
          expect(runtime.model).toMatchObject({
            id: "hooked",
            provider,
            api: "openai-completions",
            baseUrl,
          });
        } finally {
          await runtimeResources?.[Symbol.asyncDispose]();
        }
      };
      await withPluginRuntimeGenerationScope(
        { metadataSnapshot: ambientMetadata, pluginRegistry },
        run,
      );
      expect(normalizeModelId).toHaveBeenCalledExactlyOnceWith({
        provider,
        modelId: "middle",
      });
    });
  });
});
