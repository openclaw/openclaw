import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelRefOverride } from "../../shared/model-ref-override.js";
import { providerHasGenericConfig } from "./shared.js";

export async function listGenerationProviders(
  kind: "image" | "video",
  cfg: OpenClawConfig,
  agentId: string,
) {
  const list =
    kind === "image"
      ? (await import("../../image-generation/runtime.js")).listRuntimeImageGenerationProviders
      : (await import("../../video-generation/runtime.js")).listRuntimeVideoGenerationProviders;
  const selectedProvider = resolveModelRefOverride(
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.mediaModels?.[kind]),
  ).provider;
  return list({ config: cfg }).map((provider) => ({
    available: true,
    configured:
      selectedProvider === provider.id ||
      providerHasGenericConfig({ cfg, providerId: provider.id, agentId }),
    selected: selectedProvider === provider.id,
    id: provider.id,
    label: provider.label,
    defaultModel: provider.defaultModel,
    models: provider.models ?? [],
    capabilities: provider.capabilities,
  }));
}

export async function listUnderstandingProviders(
  kind: "audio" | "video",
  cfg: OpenClawConfig,
  agentId: string,
) {
  const { buildMediaUnderstandingRegistry } =
    await import("../../media-understanding/provider-registry.js");
  return [...buildMediaUnderstandingRegistry(undefined, cfg).values()]
    .filter((provider) => provider.capabilities?.includes(kind))
    .map((provider) => ({
      available: true,
      configured: providerHasGenericConfig({ cfg, providerId: provider.id, agentId }),
      selected: false,
      id: provider.id,
      capabilities: provider.capabilities,
      defaultModels: provider.defaultModels,
    }));
}
