import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolvePrimaryStringValue } from "../shared/string-coerce.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { requireValidConfigFileSnapshot } from "./agents.command-shared.js";
import {
  buildAgentSummaries,
  listAgentEntries,
} from "./agents.config.js";
import { getOptimizedModel, isModelAlreadyOptimized } from "../agents/model-optimize.js";
import type { OptimizeResult } from "../agents/model-optimize.js";

type AgentsOptimizeOptions = {
  agent?: string;
  apply?: boolean;
  json?: boolean;
};

type OptimizeEntry = {
  agentId: string;
  currentModel: string | null;
  recommendation: OptimizeResult | null;
  alreadyOptimized: boolean;
  applied?: boolean;
};

export async function agentsOptimizeCommand(
  opts: AgentsOptimizeOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
  const baseHash = configSnapshot.hash;

  // Load the model catalog for recommendations.
  let catalog;
  try {
    catalog = await loadModelCatalog({ config: cfg, useCache: false });
  } catch {
    runtime.error(
      "Could not load model catalog. Make sure your provider credentials are configured.",
    );
    runtime.exit(1);
    return;
  }

  const summaries = buildAgentSummaries(cfg);

  // Determine which agents to analyze.
  const targetAgentId = opts.agent ? normalizeAgentId(opts.agent.trim()) : null;
  const agentsToCheck = targetAgentId
    ? summaries.filter((s) => s.id === targetAgentId)
    : summaries;

  if (agentsToCheck.length === 0) {
    if (targetAgentId) {
      runtime.error(`Agent "${targetAgentId}" not found.`);
    } else {
      runtime.log("No agents configured.");
    }
    runtime.exit(1);
    return;
  }

  // Resolve effective model per agent.
  const entries: OptimizeEntry[] = agentsToCheck.map((summary) => {
    const agentEntry = listAgentEntries(cfg).find((e) => normalizeAgentId(e.id) === summary.id);
    const effectiveModel =
      resolvePrimaryStringValue(agentEntry?.model) ??
      resolvePrimaryStringValue(cfg.agents?.defaults?.model) ??
      null;

    if (!effectiveModel) {
      return { agentId: summary.id, currentModel: null, recommendation: null, alreadyOptimized: false };
    }

    if (isModelAlreadyOptimized(effectiveModel)) {
      return { agentId: summary.id, currentModel: effectiveModel, recommendation: null, alreadyOptimized: true };
    }

    const recommendation = getOptimizedModel(effectiveModel, catalog);
    return {
      agentId: summary.id,
      currentModel: effectiveModel,
      recommendation,
      alreadyOptimized: false,
    };
  });

  // JSON output — just report recommendations, no interactive prompts.
  if (opts.json) {
    writeRuntimeJson(runtime, entries.map((e) => ({
      agentId: e.agentId,
      currentModel: e.currentModel,
      alreadyOptimized: e.alreadyOptimized,
      recommendation: e.recommendation
        ? {
            recommended: e.recommendation.recommended,
            reason: e.recommendation.reason,
            fromTier: e.recommendation.fromTier,
            toTier: e.recommendation.toTier,
          }
        : null,
    })));
    return;
  }

  const hasRecommendations = entries.some((e) => e.recommendation !== null);

  if (!hasRecommendations) {
    const allOptimized = entries.every((e) => e.alreadyOptimized || e.currentModel === null);
    if (allOptimized) {
      runtime.log("All agents are already using economy-tier models. No changes needed.");
    } else {
      runtime.log(
        "No cheaper alternatives found in the current model catalog for the configured agent models.",
      );
    }
    return;
  }

  // Display recommendations.
  runtime.log("");
  runtime.log("Model Optimization Recommendations");
  runtime.log("==================================");
  runtime.log("");

  for (const entry of entries) {
    runtime.log(`Agent: ${entry.agentId}`);
    if (!entry.currentModel) {
      runtime.log("  No model configured (using default). Skipping.");
    } else if (entry.alreadyOptimized) {
      runtime.log(`  Current: ${entry.currentModel}`);
      runtime.log("  Status:  Already at economy tier — no change needed.");
    } else if (entry.recommendation) {
      runtime.log(`  Current:     ${entry.currentModel} (${entry.recommendation.fromTier})`);
      runtime.log(`  Recommended: ${entry.recommendation.recommended} (${entry.recommendation.toTier})`);
      runtime.log(`  Reason:      ${entry.recommendation.reason}`);
    } else {
      runtime.log(`  Current: ${entry.currentModel}`);
      runtime.log("  Status:  No cheaper alternative found in the current catalog.");
    }
    runtime.log("");
  }

  // If --apply flag: apply all changes without prompting.
  if (opts.apply) {
    await applyRecommendations(entries, cfg, configSnapshot.hash, runtime);
    return;
  }

  // Interactive confirm.
  const prompter = createClackPrompter();
  const actionableEntries = entries.filter((e) => e.recommendation !== null);

  if (actionableEntries.length === 0) {
    return;
  }

  const confirmMsg =
    actionableEntries.length === 1
      ? `Apply model change for agent "${actionableEntries[0].agentId}"?`
      : `Apply model changes for ${actionableEntries.length} agent(s)?`;

  const confirmed = await prompter.confirm({ message: confirmMsg, initialValue: false });
  if (!confirmed) {
    runtime.log("No changes applied.");
    return;
  }

  await applyRecommendations(entries, cfg, configSnapshot.hash, runtime);
}

async function applyRecommendations(
  entries: OptimizeEntry[],
  cfg: Parameters<typeof replaceConfigFile>[0]["nextConfig"],
  baseHash: string | undefined,
  runtime: RuntimeEnv,
) {
  const actionable = entries.filter((e) => e.recommendation !== null);
  if (actionable.length === 0) {
    return;
  }

  // Apply all changes to the config in one atomic write.
  let nextConfig = cfg as Record<string, unknown>;

  for (const entry of actionable) {
    const rec = entry.recommendation!;
    const agentList = (nextConfig.agents as { list?: unknown[] } | undefined)?.list ?? [];
    const entryIndex = (agentList as Array<{ id?: string }>).findIndex(
      (e) => normalizeAgentId(e.id ?? "") === entry.agentId,
    );

    if (entryIndex < 0) {
      // Agent not in list yet — add a minimal entry with the model override.
      const agents = (nextConfig.agents as Record<string, unknown>) ?? {};
      const list = Array.isArray(agents.list) ? [...agents.list] : [];
      list.push({ id: entry.agentId, model: rec.recommended });
      nextConfig = {
        ...nextConfig,
        agents: { ...agents, list },
      };
    } else {
      const agents = nextConfig.agents as Record<string, unknown>;
      const list = [...(agentList as unknown[])];
      const existing = list[entryIndex] as Record<string, unknown>;
      const existingModel = existing.model;

      // Preserve fallbacks if the existing model was an object with fallbacks.
      let newModel: string | { primary: string; fallbacks?: string[] } = rec.recommended;
      if (existingModel && typeof existingModel === "object" && !Array.isArray(existingModel)) {
        const fallbacks = (existingModel as { fallbacks?: unknown }).fallbacks;
        if (Array.isArray(fallbacks) && fallbacks.length > 0) {
          newModel = { primary: rec.recommended, fallbacks: fallbacks as string[] };
        }
      }

      list[entryIndex] = { ...existing, model: newModel };
      nextConfig = {
        ...nextConfig,
        agents: { ...agents, list },
      };
    }

    entry.applied = true;
  }

  await replaceConfigFile({
    nextConfig: nextConfig as Parameters<typeof replaceConfigFile>[0]["nextConfig"],
    ...(baseHash !== undefined ? { baseHash } : {}),
  });

  logConfigUpdated(runtime);

  const appliedIds = actionable.map((e) => e.agentId).join(", ");
  runtime.log(`Model optimized for: ${appliedIds}`);
}
