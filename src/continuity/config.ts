import type { SessionSendPolicyConfig } from "../config/types.base.js";
import type {
  ContinuityCaptureMode,
  ContinuityKind,
  ContinuityPluginConfig,
  ResolvedContinuityConfig,
} from "./types.js";

export const CONTINUITY_KIND_ORDER: ContinuityKind[] = [
  "preference",
  "decision",
  "fact",
  "open_loop",
];

export const CONTINUITY_FILE_BY_KIND: Record<ContinuityKind, string> = {
  fact: "memory/continuity/facts.md",
  preference: "memory/continuity/preferences.md",
  decision: "memory/continuity/decisions.md",
  open_loop: "memory/continuity/open-loops.md",
};

const DEFAULT_SCOPE: SessionSendPolicyConfig = {
  default: "deny",
  rules: [{ action: "allow", match: { chatType: "direct" } }],
};

export const DEFAULT_CONTINUITY_CONFIG: ResolvedContinuityConfig = {
  capture: {
    mainDirect: "auto",
    pairedDirect: "review",
    group: "off",
    channel: "off",
    minConfidence: 0.75,
  },
  review: {
    autoApproveMain: true,
    requireSource: true,
  },
  recall: {
    maxItems: 4,
    includeOpenLoops: true,
    scope: DEFAULT_SCOPE,
  },
};

function resolveCaptureMode(
  value: unknown,
  fallback: ContinuityCaptureMode,
): ContinuityCaptureMode {
  return value === "off" || value === "review" || value === "auto" ? value : fallback;
}

function resolvePositiveNumber(
  value: unknown,
  fallback: number,
  max?: number,
  allowZero = false,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  if (!allowZero && value === 0) {
    return fallback;
  }
  if (typeof max === "number") {
    return Math.min(value, max);
  }
  return value;
}

function resolveScopeDefault(value: unknown): "allow" | "deny" {
  return value === "allow" || value === "deny" ? value : DEFAULT_SCOPE.default;
}

function cloneScope(scope?: SessionSendPolicyConfig): SessionSendPolicyConfig {
  if (!scope) {
    return {
      default: DEFAULT_SCOPE.default,
      rules: DEFAULT_SCOPE.rules?.map((rule) => ({
        action: rule.action,
        match: rule.match ? { ...rule.match } : undefined,
      })),
    };
  }
  return {
    default: resolveScopeDefault(scope.default),
    rules: scope.rules?.map((rule) => ({
      action: rule.action,
      match: rule.match ? { ...rule.match } : undefined,
    })),
  };
}

export function resolveContinuityConfig(raw?: unknown): ResolvedContinuityConfig {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ContinuityPluginConfig) : {};
  const capture = input.capture ?? {};
  const review = input.review ?? {};
  const recall = input.recall ?? {};
  return {
    capture: {
      mainDirect: resolveCaptureMode(
        capture.mainDirect,
        DEFAULT_CONTINUITY_CONFIG.capture.mainDirect,
      ),
      pairedDirect: resolveCaptureMode(
        capture.pairedDirect,
        DEFAULT_CONTINUITY_CONFIG.capture.pairedDirect,
      ),
      group: resolveCaptureMode(capture.group, DEFAULT_CONTINUITY_CONFIG.capture.group),
      channel: resolveCaptureMode(capture.channel, DEFAULT_CONTINUITY_CONFIG.capture.channel),
      minConfidence: resolvePositiveNumber(
        capture.minConfidence,
        DEFAULT_CONTINUITY_CONFIG.capture.minConfidence,
        1,
        true,
      ),
    },
    review: {
      autoApproveMain:
        typeof review.autoApproveMain === "boolean"
          ? review.autoApproveMain
          : DEFAULT_CONTINUITY_CONFIG.review.autoApproveMain,
      requireSource:
        typeof review.requireSource === "boolean"
          ? review.requireSource
          : DEFAULT_CONTINUITY_CONFIG.review.requireSource,
    },
    recall: {
      maxItems: Math.max(
        1,
        Math.trunc(
          resolvePositiveNumber(recall.maxItems, DEFAULT_CONTINUITY_CONFIG.recall.maxItems, 12),
        ),
      ),
      includeOpenLoops:
        typeof recall.includeOpenLoops === "boolean"
          ? recall.includeOpenLoops
          : DEFAULT_CONTINUITY_CONFIG.recall.includeOpenLoops,
      scope: cloneScope(recall.scope),
    },
  };
}
