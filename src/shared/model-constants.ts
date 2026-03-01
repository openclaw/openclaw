/**
 * Sentinel value for auto model selection. When modelOverride equals this,
 * the runtime uses auto-routing (e.g. autoModelRouting) instead of a fixed model.
 */
export const AUTO_MODEL = "auto" as const;

/** Type for the AUTO_MODEL sentinel. */
export type AutoModelSentinel = typeof AUTO_MODEL;

/** Routing tag constants used by auto-model routing logic. */
export const ROUTING_TAG = {
  /** Default routing when no tag matches. */
  DEFAULT: "default",
  /** Coding/development tasks. */
  CODING: "coding",
  /** Reasoning-heavy tasks. */
  REASONING: "reasoning",
  /** Fast/chat tasks. */
  FAST: "fast",
  /** Image/multimodal tasks. */
  IMAGE: "image",
} as const;

export type RoutingTag = (typeof ROUTING_TAG)[keyof typeof ROUTING_TAG];

/** Returns true if the given model string is the AUTO_MODEL sentinel. */
export function isAutoModel(value: string | undefined): value is AutoModelSentinel {
  return value?.trim().toLowerCase() === AUTO_MODEL;
}
