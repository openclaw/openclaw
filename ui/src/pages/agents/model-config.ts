import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
// Agent model selection staged against the runtime config form, split out of
// agents-page.ts to keep that page inside the TS LOC ratchet.
import type { ApplicationContext } from "../../app/context.ts";
import type { AgentConfigEntryTarget } from "../../lib/config/config-state-model.ts";
import { readDecisionModelInventory } from "../../lib/decision-model-inventory.ts";
import type { ModelCatalogPresentation } from "../../lib/model-catalog-store.ts";

type RuntimeConfig = ApplicationContext["runtimeConfig"];

export function agentDecisionCatalogView(
  catalog: ModelCatalogPresentation,
  config: Record<string, unknown> | null,
) {
  const available = catalog.decisionModels ?? [];
  const visibleConfig = catalog.retired || catalog.modelSelectionPolicy?.restricted ? null : config;
  const inventory = readDecisionModelInventory(visibleConfig, available);
  return {
    decisionModels: available.filter((model) =>
      inventory.some((entry) => entry.ref === `${model.provider}/${model.id}`),
    ),
    decisionTasks: catalog.decisionTasks ?? [],
  };
}

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
    onDecisionTaskChange: (agentId: string, taskId: string, modelId: string | null) => {
      if (params.canUpdate(agentId)) {
        stageAgentDecisionTask(params.getRuntimeConfig(), agentId, taskId, modelId);
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

/** Null removes the task override; an empty string preserves an explicit disable. */
function stageAgentDecisionTask(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  taskId: string,
  model: string | null,
) {
  const target = runtimeConfig.agentEntry(agentId, { ensure: model !== null });
  if (!target) {
    return;
  }
  const path = [...target.path, "decisionModelsByTask", taskId];
  if (model === null) {
    runtimeConfig.removeFormValue(path);
    const currentEntry = runtimeConfig.agentEntry(agentId)?.entry;
    const remaining = currentEntry?.decisionModelsByTask;
    if (
      remaining &&
      typeof remaining === "object" &&
      !Array.isArray(remaining) &&
      Object.keys(remaining).length === 0
    ) {
      runtimeConfig.removeFormValue([...target.path, "decisionModelsByTask"]);
    }
  } else {
    runtimeConfig.patchForm(path, model);
  }
}

function modelEntry(target: AgentConfigEntryTarget) {
  return {
    path: [...target.path, "model"] as Array<string | number>,
    existing: target.entry.model,
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

/** Stage a primary-model change; clearing falls back to the inherited default. */
function stageAgentPrimaryModel(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  modelId: string | null,
) {
  const target = runtimeConfig.agentEntry(agentId, { ensure: Boolean(modelId) });
  if (!target) {
    return;
  }
  const entry = modelEntry(target);
  // Clearing the primary must not delete authored agent fallbacks: the
  // { fallbacks }-only shape stays representable.
  stageModelShape(runtimeConfig, entry.path, modelId, existingModelParts(entry.existing).fallbacks);
}

/** Stage an explicit fallback chain without changing primary inheritance. */
function stageAgentModelFallbacks(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  fallbacks: string[],
) {
  const target = runtimeConfig.agentEntry(agentId, { ensure: true });
  if (!target) {
    return;
  }
  const entry = modelEntry(target);
  stageModelShape(
    runtimeConfig,
    entry.path,
    existingModelParts(entry.existing).primary,
    normalizeStringEntries(fallbacks),
  );
}
