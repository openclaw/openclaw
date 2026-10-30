import { isStringOption } from "./string-readers.js";

// Channel adapters supply defaults; this helper owns the common flag expansion.
export type ReactionLevel = "off" | "ack" | "minimal" | "extensive";

export type ResolvedReactionLevel = {
  level: ReactionLevel;
  ackEnabled: boolean;
  agentReactionsEnabled: boolean;
  /** Guidance level for agent reactions (minimal = sparse, extensive = liberal). */
  agentReactionGuidance?: "minimal" | "extensive";
};

const LEVELS = new Set<ReactionLevel>(["off", "ack", "minimal", "extensive"]);

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
