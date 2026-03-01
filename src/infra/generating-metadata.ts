/**
 * Metadata about the generating run: thinking/reasoning levels, model selector,
 * and source. Emitted on run/event/chat surfaces for observability.
 */
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { listThinkingLevels } from "../auto-reply/thinking.js";

export type GeneratingSource =
  | "inline-directive"
  | "session-directive"
  | "auto-meta"
  | "auto-fallback"
  | "default";

export type GeneratingSelector = {
  used: boolean;
  provider: string;
  model: string;
  timedOut?: boolean;
  fallbackUsed?: boolean;
};

export type RoutingPassInfo = {
  pass: 1 | 2;
  /** Present when pass1 (router) selected model; tag from router (e.g. "expensive"). */
  tag?: "expensive";
  /** Pass1 (router) token usage when auto-model selector was used. */
  pass1TokenUsage?: {
    input?: number;
    output?: number;
    estimated?: boolean;
  };
  /** Pass2 (generation) token usage during/after generation. */
  pass2TokenUsage?: {
    input?: number;
    output?: number;
  };
};

export type GeneratingMetadata = {
  thinkingLevel: ThinkLevel;
  reasoningLevel: ReasoningLevel;
  source: GeneratingSource;
  autoReasoningEnabled: boolean;
  availableThinkingLevels: string[];
  selector?: GeneratingSelector;
  /** Routing pass info when auto-model router was used. */
  routingPass?: RoutingPassInfo;
};

export function buildGeneratingMetadata(params: {
  thinkingLevel: ThinkLevel | undefined;
  reasoningLevel: ReasoningLevel;
  source?: GeneratingSource;
  autoReasoningEnabled?: boolean;
  provider: string;
  model: string;
  effectiveThinkingLevel?: ThinkLevel;
  effectiveProvider?: string;
  effectiveModel?: string;
  selector?: GeneratingSelector;
  selectorFallbackUsed?: boolean;
  selectorTimedOut?: boolean;
  routingPass?: RoutingPassInfo;
}): GeneratingMetadata {
  const {
    thinkingLevel,
    reasoningLevel,
    source = "default",
    autoReasoningEnabled = false,
    provider,
    model,
    effectiveThinkingLevel,
    effectiveProvider,
    effectiveModel,
    selector,
    selectorFallbackUsed = false,
    selectorTimedOut = false,
    routingPass,
  } = params;
  const effProvider = effectiveProvider ?? provider;
  const effModel = effectiveModel ?? model;
  const effThinking = effectiveThinkingLevel ?? thinkingLevel ?? "off";
  const availableThinkingLevels = listThinkingLevels(effProvider, effModel);
  const selectorOut = selector
    ? {
        ...selector,
        provider: selector.provider || effProvider,
        model: selector.model || effModel,
        timedOut: selector.timedOut ?? (selectorTimedOut || undefined),
        fallbackUsed: selector.fallbackUsed ?? (selectorFallbackUsed || undefined),
      }
    : undefined;
  return {
    thinkingLevel: effThinking,
    reasoningLevel,
    source,
    autoReasoningEnabled,
    availableThinkingLevels,
    selector: selectorOut,
    ...(routingPass ? { routingPass } : {}),
  };
}
