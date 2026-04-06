/**
 * @fileoverview Intent-to-route mapping layer for OpenClaw.
 *
 * Takes an {@link IntentClassification} (from the classifier) and a
 * binding-resolved base route, then applies intent-based overrides such as
 * switching to a different agent, execution mode, or model.
 *
 * This module is designed to sit between `resolveAgentRoute()` (existing
 * binding-based dispatch) and `agentCommand()` (execution entry point),
 * providing a non-breaking extension layer.
 */

import { classifyIntent, DEFAULT_INTENT_RULES } from "./intent-classifier.js";
import type { IntentRule, IntentClassification } from "./intent-classifier.js";
import type { ResolvedAgentRoute as BaseResolvedAgentRoute } from "./resolve-route.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Extends the binding-resolved {@link BaseResolvedAgentRoute} with additional
 * fields for intent-based routing overrides.
 *
 * The `matchedBy` field is widened to `string` so that intent categories
 * (e.g., `"intent:complex"`) can be represented alongside the existing
 * binding-based literals.
 */
export type ResolvedAgentRoute = Omit<BaseResolvedAgentRoute, "matchedBy"> & {
  /** How the route was determined — binding literal or `intent:<category>`. */
  readonly matchedBy: BaseResolvedAgentRoute["matchedBy"] | `intent:${string}`;
  // --- Intent routing extensions ---
  /** Override execution mode: `'standard'` (default) or `'acp'`. */
  readonly executionMode?: "standard" | "acp";
  /** ACP backend identifier when `executionMode` is `'acp'`. */
  readonly acpBackend?: string;
  /** Override the agent's default model. */
  readonly modelOverride?: string;
  /** The intent classification that produced this route (for observability). */
  readonly intentClassification?: IntentClassification;
};

/** What to do when a classified intent has no matching route entry. */
export type IntentFallback = "binding" | "default-agent";

/** Per-category routing target overrides. */
export interface IntentRouteTarget {
  /** Override agent ID. If omitted, keeps the binding-resolved agent. */
  readonly agentId?: string;
  /** Switch execution mode. Defaults to `'standard'`. */
  readonly executionMode?: "standard" | "acp";
  /** ACP backend identifier (e.g., `"claude-code"`, `"codex"`). */
  readonly acpBackend?: string;
  /** Override the model used for this intent (e.g., `"claude-3-5-haiku"`). */
  readonly modelOverride?: string;
}

/** Top-level intent routing configuration (lives in OpenClaw's config.json5). */
export interface IntentRoutingConfig {
  /** Master switch. When `false`, intent routing is entirely skipped. */
  readonly enabled: boolean;
  /**
   * Custom classification rules. When provided, these REPLACE the default
   * rules entirely (to allow full user control). Omit to use
   * {@link DEFAULT_INTENT_RULES}.
   */
  readonly rules?: IntentRule[];
  /**
   * Maps intent categories to routing targets. Categories not listed here
   * fall through to the binding-based route.
   */
  readonly routes: Readonly<Record<string, IntentRouteTarget>>;
  /** Behavior when no route matches. Defaults to `'binding'`. */
  readonly fallback?: IntentFallback;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Resolve a final agent route by applying intent-based overrides to a
 * binding-resolved base route.
 *
 * @param baseRoute - The route produced by `resolveAgentRoute()`.
 * @param message   - The raw user message text (used for classification).
 * @param config    - Intent routing configuration.
 * @returns An augmented route with intent overrides applied, or the original
 *          `baseRoute` if intent routing is disabled or no rule matches.
 */
export function resolveIntentRoute(
  baseRoute: ResolvedAgentRoute,
  message: string,
  config: IntentRoutingConfig,
): ResolvedAgentRoute {
  // Short-circuit: disabled or no routes configured.
  if (!config.enabled || !config.routes || Object.keys(config.routes).length === 0) {
    return baseRoute;
  }

  // Classify the message.
  const rules = config.rules ?? DEFAULT_INTENT_RULES;
  const classification = classifyIntent(message, rules);

  // Default category means no rule matched — use fallback behavior.
  if (classification.category === "default") {
    return baseRoute;
  }

  // Look up the classified category in the routes map.
  const target = config.routes[classification.category];
  if (!target) {
    // Category classified but no route configured for it — fall through.
    return baseRoute;
  }

  // Apply overrides to produce the final route.
  return {
    ...baseRoute,
    agentId: target.agentId ?? baseRoute.agentId,
    matchedBy: `intent:${classification.category}`,
    executionMode: target.executionMode ?? baseRoute.executionMode,
    acpBackend: target.acpBackend ?? baseRoute.acpBackend,
    modelOverride: target.modelOverride ?? baseRoute.modelOverride,
    intentClassification: classification,
  };
}

/**
 * Convenience wrapper that combines binding-based routing with intent routing.
 *
 * In the OpenClaw codebase, this function would call `resolveAgentRoute()`
 * internally. Here we accept the base route as a parameter to keep the
 * module self-contained.
 *
 * @param baseRoute     - Pre-computed binding-based route.
 * @param message       - Raw user message text.
 * @param intentConfig  - Intent routing config (may be `undefined` if not configured).
 * @returns The final resolved route.
 */
export function resolveAgentRouteWithIntent(
  baseRoute: ResolvedAgentRoute,
  message: string,
  intentConfig?: IntentRoutingConfig,
): ResolvedAgentRoute {
  if (!intentConfig || !intentConfig.enabled) {
    return baseRoute;
  }
  return resolveIntentRoute(baseRoute, message, intentConfig);
}
