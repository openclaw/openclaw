import { isStringOption } from "./string-readers.js";

/**
 * Shared reaction-level resolver for channel plugins that expose ACK and agent reaction controls.
 * Channel adapters supply defaults/fallbacks; this helper owns the common flag expansion.
 */
/** User-configurable reaction behavior level for channel delivery. */
export type ReactionLevel = "off" | "ack" | "minimal" | "extensive";

/** Expanded reaction flags consumed by runtime delivery and prompt guidance. */
export type ResolvedReactionLevel = {
  level: ReactionLevel;
  /** Whether ACK reactions (e.g., 👀 when processing) are enabled. */
  ackEnabled: boolean;
  /** Whether agent-controlled reactions are enabled. */
  agentReactionsEnabled: boolean;
  /** Guidance level for agent reactions (minimal = sparse, extensive = liberal). */
  agentReactionGuidance?: "minimal" | "extensive";
};

const LEVELS = new Set<ReactionLevel>(["off", "ack", "minimal", "extensive"]);

/** Resolves raw reaction config into ACK and agent-reaction runtime flags. */
export function resolveReactionLevel(params: {
  value: unknown;
  defaultLevel: ReactionLevel;
  invalidFallback: "ack" | "minimal";
}): ResolvedReactionLevel {
  const value = typeof params.value === "string" ? params.value.trim() : params.value;
  const effective =
    value == null || value === ""
      ? params.defaultLevel
      : isStringOption(value, LEVELS)
        ? value
        : params.invalidFallback;

  switch (effective) {
    case "off":
      return { level: "off", ackEnabled: false, agentReactionsEnabled: false };
    case "ack":
      return { level: "ack", ackEnabled: true, agentReactionsEnabled: false };
    default: {
      const level = effective === "extensive" ? "extensive" : "minimal";
      return {
        level,
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: level,
      };
    }
  }
}
