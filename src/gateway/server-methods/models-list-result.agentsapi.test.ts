import { expect, it, onTestFinished, vi } from "vitest";
import { resolveAgentHarnessSelectionDecision } from "../../agents/harness/selection-decision.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  listModels,
  modelAuthStore,
  withModelsListState,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

const { default: plugin } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({ pluginId: "agentsapi", artifactBasename: "index.js" });
const modelId = "fixture-hosted-model";
const route = {
  provider: "openai",
  id: modelId,
  name: "Hosted fixture",
  api: "openai-responses" as const,
  baseUrl: "https://api.openai.com/v1",
};
function configuration(): OpenClawConfig {
  const model: ModelDefinitionConfig = {
    id: route.id,
    name: route.name,
    api: route.api,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      supportsTemperature: false,
      codeMode: "preferred",
    },
  };
  const defaults = {
    model: "openai/" + modelId,
    models: {
      ["openai/" + modelId]: {
        agentRuntime: { id: "openclaw" },
        pickerRuntimes: ["agentsapi"],
        params: {
          fastMode: true,
          responsesServerCompaction: true,
          responsesCompactThreshold: 700000,
        },
      },
    },
  };
  return {
    agents: { defaults },
    plugins: {
      entries: {
        agentsapi: {
          enabled: true,
          config: { forwarding: { gatewayTools: false, mcpServers: false } },
        },
      },
    },
    models: { providers: { openai: { baseUrl: route.baseUrl, models: [model] } } },
  };
}

it("accepts shared host tuning without changing normal OpenClaw selection", async () => {
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => restoreActivePluginRegistrySnapshot(previous));
  await withModelsListState(
    async (state) => {
      const cfg = configuration();
      const original = structuredClone(cfg);
      const registered = vi.fn<(harness: AgentHarness) => void>();
      if (!plugin.register) {
        throw new Error("Agents API public entry has no registration function");
      }
      plugin.register(
        createTestPluginApi({ id: "agentsapi", config: cfg, registerAgentHarness: registered }),
      );
      const harness = registered.mock.calls[0]![0];
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({ pluginId: "agentsapi", source: "fixture", harness });
      setActivePluginRegistry(registry);
      const result = await listModels({
        cfg,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        pluginRegistry: registry,
        catalog: [route],
        preparedAuthStore: modelAuthStore({
          "openai:fixture": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-test-key",
          },
        }),
      });
      expect(result.models.find((model) => model.id === modelId)?.runtimeChoices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentRuntime: expect.objectContaining({ id: "agentsapi" }),
            available: true,
          }),
        ]),
      );
      const select = (agentHarnessRuntimeOverride?: string) =>
        resolveAgentHarnessSelectionDecision({
          config: cfg,
          provider: "openai",
          modelId,
          agentHarnessRuntimeOverride,
        }).selectedHarnessId;
      expect([select(), select("agentsapi")]).toEqual(["openclaw", "agentsapi"]);
      const selectPrepared = (
        config: OpenClawConfig,
        requestTransportOverrides: "none" | "present" = "none",
      ) =>
        resolveAgentHarnessSelectionDecision({
          config,
          provider: "openai",
          modelId,
          agentHarnessRuntimeOverride: "agentsapi",
          preparedModelProvider: true,
          modelProvider: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            requestTransportOverrides,
            runtimePolicy: { compatibleIds: ["openclaw", "agentsapi"] },
            preparedAuth: { source: "profile", mode: "api-key", requirement: "api-key" },
          },
        });
      expect(selectPrepared(cfg).selectedHarnessId).toBe("agentsapi");
      expect(() => selectPrepared(cfg, "present")).toThrow();
      const rejectsChange = (change: (config: OpenClawConfig) => void) => {
        const restricted = structuredClone(cfg);
        change(restricted);
        expect(() => selectPrepared(restricted)).toThrow();
      };
      for (const params of [
        { store: false },
        { temperature: 0.3 },
        { custom_body: { example: true } },
      ]) {
        rejectsChange((c) =>
          Object.assign(c.agents!.defaults!.models!["openai/" + modelId]!.params!, params),
        );
      }
      rejectsChange((c) => {
        c.models!.providers!.openai!.headers = { "X-Policy": "required" };
      });
      rejectsChange((c) => {
        c.models!.providers!.openai!.models[0]!.compat!.supportsStore = false;
      });
      // Without the declared opt-in, shared compaction remains a strict mismatch.
      const strictHarness = { ...harness, contextManagement: undefined };
      registry.agentHarnesses[0]!.harness = strictHarness;
      expect(() => selectPrepared(cfg)).toThrow();
      registry.agentHarnesses[0]!.harness = harness;
      expect(cfg).toEqual(original);
    },
    { agentEnv: "main", env: WITHOUT_OPENAI_ENV_AUTH },
  );
});
