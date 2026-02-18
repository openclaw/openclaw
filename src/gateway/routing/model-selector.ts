import { BudgetTracker } from "./budget-tracker.js";
import { HealthTracker } from "./health-tracker.js";
import { ModelTier, TaskType, type RoutingConfig } from "./types.js";

const MODEL_TIER_ORDER = [ModelTier.TIER1, ModelTier.TIER2, ModelTier.TIER3];

/** Minimal shape needed from an agent list entry. */
export interface AgentListEntry {
  id: string;
  model?: string | { primary?: string; fallbacks?: string[] };
  tasks?: string[];
  priority?: number;
}

/**
 * Extract the full model chain from an AgentListEntry.
 * - string model  → [model]
 * - object model  → [primary, ...fallbacks]
 * - no model      → []
 */
function extractModelChain(entry: AgentListEntry): string[] {
  if (!entry.model) {
    return [];
  }
  if (typeof entry.model === "string") {
    return [entry.model];
  }
  const { primary, fallbacks } = entry.model;
  const chain: string[] = [];
  if (primary) {
    chain.push(primary);
  }
  if (fallbacks && fallbacks.length > 0) {
    chain.push(...fallbacks);
  }
  return chain;
}

export class ModelSelector {
  private healthTracker?: HealthTracker;
  private budgetTracker?: BudgetTracker;

  constructor(healthTracker?: HealthTracker, budgetTracker?: BudgetTracker) {
    this.healthTracker = healthTracker;
    this.budgetTracker = budgetTracker;
  }

  /**
   * Resolve ordered model list for a given task type.
   *
   * New logic (Phase 5):
   *   1. Search agentList for agents whose `tasks` array declares the taskType.
   *   2. Sort by priority (ascending; default 10 when unset). Stable: same-priority
   *      agents preserve their original list order.
   *   3. Extract model strings.
   *   4. If no agents matched, fall back to ha_matrix (backward compat).
   *   5. Apply health / budget filtering (same as before).
   *
   * @param taskType   The task being routed.
   * @param config     Routing configuration.
   * @param agentList  Agent entries from agents.list (optional).
   */
  resolveModels(taskType: TaskType, config: RoutingConfig, agentList?: AgentListEntry[]): string[] {
    // Budget block check — bail out immediately
    if (this.budgetTracker && config.budget?.enabled && this.budgetTracker.shouldBlock()) {
      return [];
    }

    // ── Step 1-3: agent-list-based resolution ────────────────────────────────
    const rawModelsFromAgents = this._resolveFromAgentList(taskType, agentList);

    if (rawModelsFromAgents !== null) {
      return this._applyFiltersFlat(rawModelsFromAgents, config);
    }

    // ── Step 4: ha_matrix fallback (backward compat) ─────────────────────────
    const matrix = config.ha_matrix?.[taskType] ?? config.ha_matrix?.[config.default_task_type];
    if (!matrix) {
      return [];
    }

    return this._applyFiltersTiered(matrix, config);
  }

  /**
   * Resolve models from agentList for the given taskType.
   * Returns null when no agents declare the taskType (signal to fall back).
   */
  private _resolveFromAgentList(taskType: TaskType, agentList?: AgentListEntry[]): string[] | null {
    if (!agentList || agentList.length === 0) {
      return null;
    }

    const DEFAULT_PRIORITY = 10;

    // Filter agents that declare this taskType, then stable-sort by priority
    const matched = agentList
      .filter((a) => a.tasks?.includes(taskType))
      .map((a, originalIndex) => ({ entry: a, originalIndex }))
      .toSorted(
        (x, y) =>
          (x.entry.priority ?? DEFAULT_PRIORITY) - (y.entry.priority ?? DEFAULT_PRIORITY) ||
          x.originalIndex - y.originalIndex,
      );

    if (matched.length === 0) {
      return null;
    }

    const models = matched.flatMap(({ entry }) => extractModelChain(entry));

    return models.length === 0 ? null : models;
  }

  /**
   * Apply health + budget filtering to a flat model list (agent-list path).
   */
  private _applyFiltersFlat(models: string[], config: RoutingConfig): string[] {
    const TIER_START_INDEX: Record<ModelTier, number> = {
      [ModelTier.TIER1]: 0,
      [ModelTier.TIER2]: 1,
      [ModelTier.TIER3]: 2,
    };

    const startIndex =
      this.budgetTracker && config.budget?.enabled
        ? (TIER_START_INDEX[this.budgetTracker.getSuggestedStartTier()] ?? 0)
        : 0;

    const threshold = config.health?.threshold ?? 0.5;
    const filtered: string[] = [];

    for (let i = startIndex; i < models.length; i++) {
      const model = models[i];
      if (this.healthTracker && config.health?.enabled) {
        if (!this.healthTracker.isHealthy(model, threshold)) {
          continue;
        }
      }
      filtered.push(model);
    }

    // Budget critical + degrade → try fallback_model
    if (filtered.length === 0 && this.budgetTracker && config.budget?.enabled) {
      const fallback = this.budgetTracker.getFallbackModel();
      if (fallback) {
        return [fallback];
      }
    }

    // Safety net: return original unfiltered list
    if (filtered.length === 0) {
      return models;
    }

    return filtered;
  }

  /**
   * Apply health + budget filtering to a tier-based matrix (ha_matrix path).
   * Identical to the original resolveModels logic.
   */
  private _applyFiltersTiered(
    matrix: Partial<Record<ModelTier, string>>,
    config: RoutingConfig,
  ): string[] {
    // Determine starting tier (budget-aware)
    const startTier =
      this.budgetTracker && config.budget?.enabled
        ? this.budgetTracker.getSuggestedStartTier()
        : ModelTier.TIER1;

    const threshold = config.health?.threshold ?? 0.5;
    const models: string[] = [];
    let started = false;

    for (const tier of MODEL_TIER_ORDER) {
      if (!started && tier !== startTier) {
        continue;
      }
      started = true;

      const model = matrix[tier];
      if (!model) {
        continue;
      }

      // Skip unhealthy models when health tracking is enabled
      if (this.healthTracker && config.health?.enabled) {
        if (!this.healthTracker.isHealthy(model, threshold)) {
          continue;
        }
      }

      models.push(model);
    }

    // Budget critical + degrade: prefer fallback_model if everything else is empty
    if (models.length === 0 && this.budgetTracker && config.budget?.enabled) {
      const fallback = this.budgetTracker.getFallbackModel();
      if (fallback) {
        return [fallback];
      }
    }

    // Safety net: if all tiers were filtered out, return original unfiltered list
    if (models.length === 0) {
      return MODEL_TIER_ORDER.map((t) => matrix[t]).filter((m): m is string => !!m);
    }

    return models;
  }
}
