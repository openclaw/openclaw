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
        stageAgentPrimaryModel(params.getRuntimeConfig(), agentId, modelId);
        params.onPrimaryChanged();
      }
    },
    onDecisionModelChange: (agentId: string, modelId: string | null) => {
      if (params.canUpdate(agentId)) {
        stageAgentDecisionModel(params.getRuntimeConfig(), agentId, modelId);
      }
    },
    onModelFallbacksChange: (agentId: string, fallbacks: string[]) => {
      if (params.canUpdate(agentId)) {
        stageAgentModelFallbacks(params.getRuntimeConfig(), agentId, fallbacks);
      }
    },
  };
}

/** Null inherits; an empty string is an explicit per-agent disable. */
function stageAgentDecisionModel(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  model: string | null,
) {
  const target = runtimeConfig.agentEntry(agentId, { ensure: model !== null });
  if (!target) {
    return;
  }
  const path = [...target.path, "decisionModel"];
  if (model === null) {
    runtimeConfig.removeFormValue(path);
  } else {
    runtimeConfig.patchForm(path, model);
  }
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

function stageAgentPrimaryModel(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  modelId: string | null,
) {
  const target = runtimeConfig.agentEntry(agentId, { ensure: Boolean(modelId) });
  if (!target) {
    return;
  }
  // Clearing the primary must not delete authored agent fallbacks: the
  // { fallbacks }-only shape stays representable.
  stageModelShape(
    runtimeConfig,
    [...target.path, "model"],
    modelId,
    existingModelParts(target.entry.model).fallbacks,
  );
}

function stageAgentModelFallbacks(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  fallbacks: string[],
) {
  const target = runtimeConfig.agentEntry(agentId, { ensure: true });
  if (!target) {
    return;
  }
  stageModelShape(
    runtimeConfig,
    [...target.path, "model"],
    existingModelParts(target.entry.model).primary,
    normalizeStringEntries(fallbacks),
  );
}
