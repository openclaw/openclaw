// Registered in the command suite to reuse its runtime and database fixture.
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

  it("validates an unconfigured model against manifest thinking capabilities without live discovery", async () => {
    await withTempHome(async (home) => {
      mockConfig(home, path.join(home, "sessions.json"), { models: {} });
      vi.mocked(loadManifestModelCatalog).mockReturnValue([
        {
          provider: "reasoning-test",
          id: "catalog-max",
          name: "Catalog reasoning model",
          api: "openai-completions",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["max"] },
        },
      ]);

      await agentCommand(
        {
          message: "ping",
          to: "+1222",
          model: "reasoning-test/catalog-max",
          thinking: "max",
        },
        runtime,
      );

      expect(getLastEmbeddedCall()?.thinkLevel).toBe("max");
      expect(readPreparedModelCatalog).not.toHaveBeenCalled();
    });
  });

  it.each(["off"] as const)(
    "validates native %s against observed capabilities despite manifest reasoning",
    async (thinking) => {
      await withTempHome(async (home) => {
        mockConfig(home, path.join(home, "sessions.json"), {
          model: { primary: "openai/account-reasoner" },
          models: { "openai/account-reasoner": {} },
        });
        const registry = createTestRegistry();
        registry.providers.push({
          pluginId: "openai",
          source: "test",
          provider: {
            id: "openai",
            label: "OpenAI",
            auth: [],
            resolveThinkingProfile: expectDefined(
              resolveProviderPolicySurface("openai")?.resolveThinkingProfile,
              "OpenAI thinking policy",
            ),
          },
        });
        setActivePluginRegistry(registry);
        vi.mocked(loadManifestModelCatalog).mockReturnValue([
          {
            provider: "openai",
            id: "account-reasoner",
            name: "Catalog reasoning model",
            api: "openai-chatgpt-responses",
            reasoning: true,
            compat: { supportedReasoningEfforts: ["none", "high", "max"] },
          },
        ]);
        vi.mocked(resolveEffectiveAgentRuntime).mockReturnValue("codex");
        vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([
          {
            provider: "openai",
            id: "account-reasoner",
            name: "Native reasoning model",
            nativeRuntime: "codex",
            reasoning: true,
            compat: { supportedReasoningEfforts: ["high"] },
          },
        ]);

        await expect(
          agentCommand(
            { message: "ping", to: "+1222", model: "openai/account-reasoner", thinking },
            runtime,
          ),
        ).rejects.toThrow(
          `Thinking level "${thinking}" is not supported for openai/account-reasoner.`,
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
      });
    },
  );

  it("enforces xAI's effort-free profile for off", async () => {
    await withTempHome(async (home) => {
      const model = applyXaiRuntimeModelCompat({
        provider: "xai",
        id: "grok-4.20-0309-reasoning",
        name: "Grok 4.20",
        api: "openai-responses",
        reasoning: true,
        thinkingLevelMap: { off: null, high: "high" },
      });
      const modelRef = `xai/${model.id}`;
      mockConfig(home, path.join(home, "sessions.json"), {
        model: { primary: modelRef },
        models: { [modelRef]: {} },
      });
      const registry = createTestRegistry();
      registry.providers.push({
        pluginId: "xai",
        source: "test",
        provider: {
          id: "xai",
          label: "xAI",
          auth: [],
          resolveThinkingProfile: expectDefined(
            resolveProviderPolicySurface("xai")?.resolveThinkingProfile,
            "xAI thinking policy",
          ),
        },
      });
      setActivePluginRegistry(registry);
      vi.mocked(loadManifestModelCatalog).mockReturnValue([model]);

      await agentCommand(
        { message: "ping", to: "+1222", model: modelRef, thinking: "off" },
        runtime,
      );
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(getLastEmbeddedCall()).toMatchObject({
        provider: "xai",
        model: model.id,
        thinkLevel: "off",
      });
    });
  });
}
