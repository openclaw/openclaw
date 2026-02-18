/**
 * Routing singleton module — Phase 4
 *
 * Provides a lazily-initialized singleton that bundles:
 *   - HealthTracker
 *   - BudgetTracker
 *   - ReviewGate
 *   - ModelSelector (constructed with health + budget trackers)
 *
 * The singleton is keyed on the RoutingConfig object reference.  When a new
 * config is detected (e.g. config reload) pass the new config and a fresh
 * instance will be created.
 */

import type { EmbeddingProvider } from "../../memory/embeddings.js";
import { BudgetTracker } from "./budget-tracker.js";
import { HealthTracker } from "./health-tracker.js";
import { ModelSelector } from "./model-selector.js";
import { ReviewGate } from "./review-gate.js";
import { SemanticRouter } from "./semantic-router.js";
import type { RoutingConfig } from "./types.js";
import { ROUTE_UTTERANCES } from "./utterances.js";

export interface RoutingInstance {
  healthTracker: HealthTracker;
  budgetTracker: BudgetTracker;
  reviewGate: ReviewGate;
  selector: ModelSelector;

  /**
   * L1.5 Semantic Router — available after setEmbeddingProvider() is called
   * and the background init completes.
   */
  semanticRouter?: SemanticRouter;

  /** Serialize health + budget state for persistence */
  serialize(): { health: string; budget: string };

  /**
   * Restore health + budget state from previously serialized data.
   * Silently ignores malformed input.
   */
  deserialize(data: { health: string; budget: string }): void;

  /**
   * Provide an EmbeddingProvider to enable the L1.5 Semantic Router.
   * Triggers background init (non-blocking). Safe to call multiple times;
   * subsequent calls are no-ops if a router is already initializing/initialized.
   *
   * @param provider - EmbeddingProvider from the memory manager
   * @param threshold - Optional cosine similarity threshold (overrides config)
   */
  setEmbeddingProvider(provider: EmbeddingProvider, threshold?: number): void;
}

// Singleton storage — one instance per RoutingConfig reference.
let _currentConfig: RoutingConfig | undefined;
let _instance: RoutingInstance | undefined;
let _routerInitializing = false;

/**
 * Return (or lazily create) the routing singleton for a given config.
 *
 * If the config object reference changes a new instance is constructed and
 * the previous one is discarded.
 */
export function getRoutingInstance(config: RoutingConfig): RoutingInstance {
  if (_instance && _currentConfig === config) {
    return _instance;
  }

  // Config changed — reset the initializing flag so the new instance
  // isn't blocked by a stale flag from the previous instance.
  _routerInitializing = false;

  // Build sub-components from config
  const healthTracker = new HealthTracker(config.health?.window_size ?? 20);

  // BudgetConfig is required by BudgetTracker — provide a safe default when
  // the budget section is absent from config.
  const budgetConfig = config.budget ?? {
    enabled: false,
    daily_budget_usd: 0,
    daily_token_limit: 0,
    warning_threshold: 0.8,
    critical_action: "degrade" as const,
  };
  const budgetTracker = new BudgetTracker(budgetConfig);

  // ReviewGateConfig — provide a safe default when absent.
  const reviewGateConfig = config.review_gate ?? {
    enabled: false,
    mode: "manual" as const,
    high_risk_types: [],
    reviewer_model: "",
    reviewer_system_prompt: "",
    timeout_ms: 60_000,
  };
  const reviewGate = new ReviewGate(reviewGateConfig);

  const selector = new ModelSelector(healthTracker, budgetTracker);

  const instance: RoutingInstance = {
    healthTracker,
    budgetTracker,
    reviewGate,
    selector,
    semanticRouter: undefined,

    serialize() {
      return {
        health: healthTracker.serialize(),
        budget: budgetTracker.serialize(),
      };
    },

    deserialize(data: { health: string; budget: string }) {
      try {
        if (data.health) {
          healthTracker.deserialize(data.health);
        }
      } catch {
        // ignore malformed health data
      }
      try {
        if (data.budget) {
          budgetTracker.deserialize(data.budget);
        }
      } catch {
        // ignore malformed budget data
      }
    },

    setEmbeddingProvider(provider: EmbeddingProvider, threshold?: number) {
      // No-op if semantic router config is disabled
      if (config.semantic_router?.enabled === false) {
        return;
      }
      // No-op if already initialized or initializing
      if (this.semanticRouter?.isInitialized || _routerInitializing) {
        return;
      }

      _routerInitializing = true;
      const effectiveThreshold = threshold ?? config.semantic_router?.threshold;
      const router = new SemanticRouter(
        provider,
        effectiveThreshold,
        config.semantic_router?.min_gap,
      );

      // Assign immediately so resolve() can be called (it guards on isInitialized)
      this.semanticRouter = router;

      // Background init — non-blocking
      router
        .init(ROUTE_UTTERANCES)
        .then(() => {
          _routerInitializing = false;
          console.info(`[routing] semantic-router initialized: ${router.routeCount} route entries`);
        })
        .catch((err: unknown) => {
          _routerInitializing = false;
          console.warn("[routing] semantic-router init failed:", err);
          // Remove the router so resolve() falls through to FALLBACK
          this.semanticRouter = undefined;
        });
    },
  };

  _currentConfig = config;
  _instance = instance;
  return instance;
}

/**
 * Reset the singleton (primarily for testing).
 */
export function resetRoutingInstance(): void {
  _currentConfig = undefined;
  _instance = undefined;
  _routerInitializing = false;
}
