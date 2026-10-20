import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { loadManifestModelCatalog } from "../agents/model-catalog.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import {
  loadProviderScopedThinkingCatalog,
  readPreparedModelCatalog,
} from "../agents/prepared-model-catalog.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { agentCommand } from "./agent.js";
export function registerAgentThinkingTests({
  withTempHome,
  mockConfig,
  getLastEmbeddedCall,
  runtime,
}: {
  withTempHome: <T>(fn: (home: string) => Promise<T>) => Promise<T>;
  mockConfig: (
    home: string,
    storePath: string,
    agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  ) => OpenClawConfig;
  getLastEmbeddedCall: () => Parameters<typeof runEmbeddedAgent>[0] | undefined;
  runtime: RuntimeEnv;
}) {
  const { applyXaiRuntimeModelCompat } = loadBundledPluginPublicArtifactModuleSync<{
    applyXaiRuntimeModelCompat: (model: ModelCatalogEntry) => ModelCatalogEntry;
  }>({ dirName: "xai", artifactBasename: "api.js" });
  const run = (model: string, thinking: "off" | "max") =>
    agentCommand({ message: "ping", to: "+1222", model, thinking }, runtime);
  const catalogModel = (overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry => ({
    provider: "openai",
    id: "account-reasoner",
    name: "Reasoning model",
    reasoning: true,
    ...overrides,
  });
  const configure = (home: string, overrides: Partial<ModelCatalogEntry>) => {
    const model = catalogModel(overrides);
    const ref = `${model.provider}/${model.id}`;
    mockConfig(home, path.join(home, "sessions.json"), {
      model: { primary: ref },
      models: { [ref]: {} },
    });
    vi.mocked(loadManifestModelCatalog).mockReturnValue([model]);
    installThinkingProvider(model.provider);
    return ref;
  };
  function installThinkingProvider(id: string) {
    const registry = createTestRegistry();
    registry.providers.push({
      pluginId: id,
      source: "test",
      provider: {
        id,
        label: id,
        auth: [],
        resolveThinkingProfile: expectDefined(
          resolveProviderPolicySurface(id)?.resolveThinkingProfile,
          `${id} thinking policy`,
        ),
      },
    });
    setActivePluginRegistry(registry);
  }
  it("validates unconfigured model thinking without live discovery", () =>
    withTempHome(async (home) => {
      mockConfig(home, path.join(home, "sessions.json"), { models: {} });
      vi.mocked(loadManifestModelCatalog).mockReturnValue([
        catalogModel({
          provider: "reasoning-test",
          id: "catalog-max",
          api: "openai-completions",
          compat: { supportedReasoningEfforts: ["max"] },
        }),
      ]);
      await run("reasoning-test/catalog-max", "max");
      expect(getLastEmbeddedCall()?.thinkLevel).toBe("max");
      expect(readPreparedModelCatalog).not.toHaveBeenCalled();
    }));
  it("validates native off against observations over the manifest", () =>
    withTempHome(async (home) => {
      const ref = configure(home, {
        api: "openai-chatgpt-responses",
        compat: { supportedReasoningEfforts: ["none", "high", "max"] },
      });
      vi.mocked(resolveEffectiveAgentRuntime).mockReturnValue("codex");
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([
        catalogModel({
          nativeRuntime: "codex",
          compat: { supportedReasoningEfforts: ["high"] },
        }),
      ]);
      await expect(run(ref, "off")).rejects.toThrow(
        'Thinking level "off" is not supported for openai/account-reasoner.',
      );
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          model: "account-reasoner",
          agentRuntime: "codex",
        }),
      );
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(readPreparedModelCatalog).not.toHaveBeenCalled();
    }));

  it("enforces xAI's effort-free profile for off", () =>
    withTempHome(async (home) => {
      const model = applyXaiRuntimeModelCompat(
        catalogModel({
          provider: "xai",
          id: "grok-4.20-0309-reasoning",
          api: "openai-responses",
          thinkingLevelMap: { off: null, high: "high" },
        }),
      );
      const modelRef = configure(home, model);
      await run(modelRef, "off");
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(getLastEmbeddedCall()).toMatchObject({
        provider: "xai",
        model: model.id,
        thinkLevel: "off",
      });
    }));
}
