import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveModelAgentRuntimeMetadata } from "../../agents/agent-runtime-metadata.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentRuntimeLabel } from "../../status/agent-runtime-label.js";

function providerQualifiedCatalogModelId(entry: ModelCatalogEntry): string {
  const modelId = entry.id.trim();
  const provider = entry.provider?.trim();
  if (!provider || !modelId) {
    return modelId;
  }
  const slash = modelId.indexOf("/");
  if (slash > 0 && normalizeProviderId(modelId.slice(0, slash)) === normalizeProviderId(provider)) {
    return modelId;
  }
  return `${provider}/${modelId}`;
}

export function addConfiguredAgentRuntimeMetadata<T extends ModelCatalogEntry>(params: {
  cfg: OpenClawConfig;
  agentId: string;
  catalog: T[];
}): T[] {
  return params.catalog.map((entry) => {
    const agentRuntime = resolveModelAgentRuntimeMetadata({
      cfg: params.cfg,
      agentId: params.agentId,
      provider: entry.provider,
      model: providerQualifiedCatalogModelId(entry),
    });
    if (
      agentRuntime.source === "implicit" &&
      (agentRuntime.id === "openclaw" ||
        agentRuntime.id === "auto" ||
        agentRuntime.id === "default")
    ) {
      return entry;
    }
    return {
      ...entry,
      agentRuntime: {
        ...agentRuntime,
        label: resolveAgentRuntimeLabel({
          config: params.cfg,
          resolvedHarness: agentRuntime.id,
          fallbackProvider: entry.provider,
        }),
      },
    } as T;
  });
}
