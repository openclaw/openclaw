import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
// Agent model selection staged against the runtime config form, split out of
// agents-page.ts to keep that page inside the TS LOC ratchet.
import type { ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import type { AgentConfigEntryTarget } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { DecisionModelSetupController } from "../model-providers/decision-setup-controller.ts";

type RuntimeConfig = ApplicationContext["runtimeConfig"];

function createAgentModelActions(params: {
  getRuntimeConfig: () => RuntimeConfig;
  canUpdate: (agentId: string) => boolean;
  onPrimaryChanged: () => void;
  onDecisionSetup?: (model: string | null, commit: () => void) => void;
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
        const commit = () => {
          if (params.canUpdate(agentId)) {
            stageAgentDecisionModel(params.getRuntimeConfig(), agentId, modelId);
          }
        };
        if (params.onDecisionSetup) {
          params.onDecisionSetup(modelId, commit);
        } else {
          commit();
        }
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

/** One composition binds setup and staged model edits to the current agent. */
export function createAgentModelSettings(
  host: ReactiveControllerHost,
  options: {
    getScope: () => { context: ApplicationContext; agentId: string | null };
    getModels: () => readonly DecisionModelEntry[];
    onPrimaryChanged: () => void;
  },
) {
  const decision = new DecisionModelSetupController(host, {
    getScope: options.getScope,
    getModels: options.getModels,
    getSelection: () => {
      const { context, agentId } = options.getScope();
      const value = agentId
        ? context.runtimeConfig.agentEntry(agentId)?.entry.decisionModel
        : undefined;
      return typeof value === "string" ? value : null;
    },
  });
  const actions = createAgentModelActions({
    getRuntimeConfig: () => options.getScope().context.runtimeConfig,
    canUpdate: (agentId) => {
      const current = options.getScope();
      return (
        current.agentId === agentId &&
        canCallGatewayMethod(current.context.gateway.snapshot, "config.set", "operator.admin")
      );
    },
    onPrimaryChanged: options.onPrimaryChanged,
    onDecisionSetup: (value, commit) => decision.choose(value, commit),
  });
  return { decision, actions };
}
