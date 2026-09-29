import { vi } from "vitest";
import { resolveModelRuntimePolicy } from "../../agents/model-runtime-policy.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginModelRuntimeMock(
  defaults: PluginRuntime["agent"]["defaults"],
): Pick<PluginRuntime, "decisions" | "modelConfig" | "modelAuth" | "llm"> {
  return {
    decisions: {
      evaluate: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "disabled" as const,
      })),
    },
    modelConfig: {
      resolveDefaultModelForAgent:
        vi.fn<PluginRuntime["modelConfig"]["resolveDefaultModelForAgent"]>(),
      resolveAllowedModelRef: vi.fn<PluginRuntime["modelConfig"]["resolveAllowedModelRef"]>(),
      resolveModelRuntimePolicy: vi.fn(resolveModelRuntimePolicy),
    },
    modelAuth: {
      resolveProviderIdForAuth: vi.fn<PluginRuntime["modelAuth"]["resolveProviderIdForAuth"]>(
        (provider) => provider,
      ),
      ensureAuthProfileStore: vi.fn<PluginRuntime["modelAuth"]["ensureAuthProfileStore"]>(() => ({
        version: 1,
        profiles: {},
      })),
      resolveAuthProfileOrder: vi.fn<PluginRuntime["modelAuth"]["resolveAuthProfileOrder"]>(
        () => [],
      ),
      listProfilesForProvider: vi.fn<PluginRuntime["modelAuth"]["listProfilesForProvider"]>(
        () => [],
      ),
      isProviderApiKeyConfigured: vi.fn<PluginRuntime["modelAuth"]["isProviderApiKeyConfigured"]>(
        () => false,
      ),
      getApiKeyForModel: vi.fn<PluginRuntime["modelAuth"]["getApiKeyForModel"]>(),
      getRuntimeAuthForModel: vi.fn<PluginRuntime["modelAuth"]["getRuntimeAuthForModel"]>(),
      resolveApiKeyForProvider: vi.fn<PluginRuntime["modelAuth"]["resolveApiKeyForProvider"]>(),
    },
    llm: {
      acquireLocalService: vi.fn(),
      complete: vi.fn().mockResolvedValue({
        text: "{}",
        provider: defaults.provider,
        model: defaults.model,
        agentId: "main",
        usage: {},
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: defaults.provider },
        },
        audit: { caller: { kind: "plugin", id: "test" } },
      }),
    },
  };
}
