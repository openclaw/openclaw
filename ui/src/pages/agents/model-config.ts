import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { ApplicationContext } from "../../app/context.ts";

type RuntimeConfig = ApplicationContext["runtimeConfig"];

export function createAgentModelActions(params: {
  getRuntimeConfig: () => RuntimeConfig;
  canUpdate: (agentId: string) => boolean;
  onPrimaryChanged: () => void;
}) {
  return {
    onModelChange: (agentId: string, modelId: string | null) => {
      if (params.canUpdate(agentId)) {
        const runtimeConfig = params.getRuntimeConfig();
        const target = runtimeConfig.agentEntry(agentId, { ensure: Boolean(modelId) });
        if (target) {
          // Clearing the primary must preserve authored agent fallbacks.
          stageModelShape(
            runtimeConfig,
            [...target.path, "model"],
            modelId,
            existingModelParts(target.entry.model).fallbacks,
          );
        }
        params.onPrimaryChanged();
      }
    },
    onDecisionModelChange: (agentId: string, modelId: string | null) => {
      if (params.canUpdate(agentId)) {
        const runtimeConfig = params.getRuntimeConfig();
        const target = runtimeConfig.agentEntry(agentId, { ensure: modelId !== null });
        if (target) {
          const path = [...target.path, "decisionModel"];
          // Null inherits; an empty string explicitly disables the per-agent model.
          if (modelId === null) {
            runtimeConfig.removeFormValue(path);
          } else {
            runtimeConfig.patchForm(path, modelId);
          }
        }
      }
    },
    onModelFallbacksChange: (agentId: string, fallbacks: string[]) => {
      if (params.canUpdate(agentId)) {
        const runtimeConfig = params.getRuntimeConfig();
        const target = runtimeConfig.agentEntry(agentId, { ensure: true });
        if (target) {
          stageModelShape(
            runtimeConfig,
            [...target.path, "model"],
            existingModelParts(target.entry.model).primary,
            normalizeStringEntries(fallbacks),
          );
        }
      }
    },
  };
}

// Stage the smallest config shape that expresses the selection. The gateway
// resolver honors a bare string, { primary, fallbacks }, and { fallbacks }
// with no primary (agent-scope.ts); staging must write all three or an
// authored piece of the selection silently disappears.
function stageModelShape(
  runtimeConfig: RuntimeConfig,
  path: Array<string | number>,
  primary: string | null,
  fallbacks: string[] | null,
) {
  if (primary && fallbacks) {
    runtimeConfig.patchForm(path, { primary, fallbacks });
  } else if (primary) {
    runtimeConfig.patchForm(path, primary);
  } else if (fallbacks) {
    runtimeConfig.patchForm(path, { fallbacks });
  } else {
    runtimeConfig.removeFormValue(path);
  }
}

function existingModelParts(existing: unknown): {
  primary: string | null;
  fallbacks: string[] | null;
} {
  if (typeof existing === "string") {
    return { primary: existing.trim() || null, fallbacks: null };
  }
  if (existing && typeof existing === "object") {
    const record = existing as { primary?: unknown; fallbacks?: unknown };
    return {
      primary: typeof record.primary === "string" ? record.primary.trim() || null : null,
      fallbacks: Array.isArray(record.fallbacks) ? (record.fallbacks as string[]) : null,
    };
  }
  return { primary: null, fallbacks: null };
}
