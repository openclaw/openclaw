import { describe, expect, it, vi } from "vitest";
import { createEmptyAgentDiscoveryStores } from "../agents/embedded-agent-runner/model.js";
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
  it.each(
    (["entry", "middle", "plain"] as const).flatMap((input) =>
      ([false, true] as const).flatMap((scoped) =>
        ([undefined, "openai-completions"] as const).map((api) => ({ input, scoped, api })),
      ),
    ),
  )(
    "uses supplied metadata for $input with scoped hooks=$scoped and provider API=$api",
    async ({ input, scoped, api }) => {
      await withOpenClawTestState({ label: "image-selected-model" }, async (state) => {
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir } },
          models: {
            providers: {
              [provider]: {
                baseUrl,
                apiKey: "synthetic-fixture",
                ...(api ? { api } : {}),
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
          configuredRuntimeModels: rows.map((model) => ({ provider, modelId: model.id, model })),
          inlineProviderModels: [],
          createStores: () => stores,
        };
        const expected =
          input === "entry"
            ? scoped
              ? "hooked"
              : "middle"
            : input === "middle"
              ? "final"
              : "plain";
        const run = async () => {
          let release: (() => void) | undefined;
          try {
            const runtime = await resolveImageRuntime(
              {
                cfg,
                agentDir: state.agentDir(),
                provider,
                model: input,
                preparedModelRuntime: snapshot,
              },
              (resources) => {
                release = resources.release;
              },
            );
            expect(runtime.model).toMatchObject({
              id: expected,
              provider,
              api: "openai-completions",
              baseUrl,
            });
          } finally {
            release?.();
          }
        };
        if (scoped) {
          await withPluginRuntimeGenerationScope(
            { metadataSnapshot: ambientMetadata, pluginRegistry },
            run,
          );
        } else {
          await run();
        }
        if (scoped) {
          expect(normalizeModelId).toHaveBeenCalledExactlyOnceWith({
            provider,
            modelId: input === "entry" ? "middle" : input === "middle" ? "final" : "plain",
          });
        } else {
          expect(normalizeModelId).not.toHaveBeenCalled();
        }
      });
    },
  );
});
