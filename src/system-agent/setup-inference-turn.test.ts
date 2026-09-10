import { describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  loadSetupInferencePluginGeneration,
  revalidateStableSetupInferenceOwner,
} from "./setup-inference-turn.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";

const mocks = vi.hoisted(() => ({ loadAgentRuntimePluginRegistryHandle: vi.fn() }));
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

function embeddedRoute(): SystemAgentConfiguredRoute {
  const config: OpenClawConfig = {
    agents: {
      entries: { main: { default: true, agentDir: "/tmp/openclaw-agent" } },
      defaults: {
        model: "openai/gpt-5.6-sol",
        models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
        workspace: "/tmp/openclaw-workspace",
      },
    },
  };
  return {
    runner: "embedded",
    provider: "openai",
    model: "gpt-5.6-sol",
    modelLabel: "openai/gpt-5.6-sol",
    agentId: "main",
    agentDir: "/tmp/openclaw-agent",
    agentHarnessRuntimeOverride: "codex",
    sourceConfig: config,
    runConfig: config,
  };
}

describe("setup inference plugin ownership", () => {
  it("loads newly installed package facts after the install lease cached their absence", async () => {
    await withOpenClawTestState(
      { label: "setup-plugin-generation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config = {
          plugins: {
            allow: ["fixture-runtime"],
            load: { paths: [state.statePath("plugin")] },
            entries: { "fixture-runtime": { enabled: true } },
          },
        };
        await withPluginCache(createPluginCache(), async () => {
          const input = { config, workspaceDir: state.workspaceDir, allowCurrent: false };
          const before = resolvePluginMetadataSnapshot(input);
          expect(before.byPluginId.has("fixture-runtime")).toBe(false);
          await state.writeJson("plugin/package.json", {
            name: "@fixture/runtime",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          });
          await state.writeJson("plugin/openclaw.plugin.json", {
            id: "fixture-runtime",
            agentHarnesses: ["fixture-runtime"],
            configSchema: { type: "object" },
          });
          await state.writeText("plugin/index.js", 'throw new Error("metadata must not execute");');
          mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(
            createEmptyPluginRegistry(),
          );
          const generation = loadSetupInferencePluginGeneration({
            config,
            workspaceDir: state.workspaceDir,
            selection: { provider: "fixture", modelId: "model", runtime: "fixture-runtime" },
          });
          expect(generation.metadataSnapshot.byPluginId.has("fixture-runtime")).toBe(true);
          expect(resolvePluginMetadataSnapshot(input)).toBe(before);
        });
      },
    );
  });

  it.each([true, false])(
    "retains the probing registry artifact preference (%s)",
    async (preferBuiltPluginArtifacts) => {
      const order: string[] = [];
      const pluginRegistry = createEmptyPluginRegistry();
      const route = embeddedRoute();
      const { binding } = await createSystemAgentVerifiedInferenceTestFixture(route.sourceConfig);
      const metadataSnapshot = createPluginMetadataSnapshot({
        config: route.runConfig,
        manifestRegistry: makeRegistry([]),
        workspaceDir: "/tmp/openclaw-workspace",
      });
      const probingRegistry = createEmptyPluginRegistry();
      setPluginRuntimeLoadContext(
        probingRegistry,
        resolvePluginRuntimeLoadContext({
          config: route.runConfig,
          metadataSnapshot,
          preferBuiltPluginArtifacts,
        }),
      );
      const previousMetadata = getCurrentPluginMetadataSnapshot();
      const resolveMetadataSnapshot = vi.fn(() => {
        order.push("metadata");
        return metadataSnapshot;
      });
      mocks.loadAgentRuntimePluginRegistryHandle.mockImplementationOnce(() => {
        order.push("load");
        expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
        return pluginRegistry;
      });
      const createSystemAgentVerifiedInferenceBinding = vi.fn(async () => {
        order.push("validate");
        expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
        return binding;
      });

      await withPluginRuntimeRegistryScope(probingRegistry, async () => {
        await expect(
          revalidateStableSetupInferenceOwner({
            route,
            auth: {
              agentHarnessId: "codex",
              runtimeOwnerKind: "plugin-harness",
            },
            stagedOwnerPluginArtifacts: binding,
            deps: {
              createSystemAgentVerifiedInferenceBinding,
              resolvePluginMetadataSnapshot: resolveMetadataSnapshot,
            },
          }),
        ).resolves.toBe(binding);
      });

      expect(order).toEqual(["metadata", "load", "validate"]);
      expect(getCurrentPluginMetadataSnapshot()).toBe(previousMetadata);
      expect(resolveMetadataSnapshot).toHaveBeenCalledWith({
        config: route.runConfig,
        env: process.env,
        workspaceDir: "/tmp/openclaw-workspace",
        allowCurrent: false,
      });
      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith({
        config: route.runConfig,
        metadataSnapshot,
        preferBuiltPluginArtifacts,
        workspaceDir: "/tmp/openclaw-workspace",
        selections: [
          { provider: "openai", modelId: "gpt-5.6-sol", runtime: "codex", agentId: "main" },
        ],
      });
    },
  );

  it("does not load plugins for a direct custom provider using the built-in OpenClaw harness", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { default: true, agentDir: "/tmp/openclaw-agent" } },
        defaults: {
          model: "fixture/direct-model",
          models: { "fixture/direct-model": { agentRuntime: { id: "openclaw" } } },
          workspace: "/tmp/openclaw-workspace",
        },
      },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://provider.example/v1",
            models: [],
          },
        },
      },
    };
    const { binding } = await createSystemAgentVerifiedInferenceTestFixture(config);
    expect(binding.ownerPluginIds).toEqual([]);
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();

    await expect(
      revalidateStableSetupInferenceOwner({
        route: binding.execution,
        auth: binding.auth,
        stagedOwnerPluginArtifacts: binding,
        deps: {
          createSystemAgentVerifiedInferenceBinding: vi.fn(async () => binding),
        },
      }),
    ).resolves.toBe(binding);

    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });
});
