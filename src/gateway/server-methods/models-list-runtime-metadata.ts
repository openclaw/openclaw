import { resolveModelAgentRuntimeMetadata } from "../../agents/agent-runtime-metadata.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentRuntimeLabel } from "../../status/agent-runtime-label.js";

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
      model: entry.id,
    });
    if (agentRuntime.source === "implicit") {
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
