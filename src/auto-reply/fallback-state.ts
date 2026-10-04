/** Formats model-fallback notice state for UI/status messages and persisted transition tracking. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { formatRawAssistantErrorForUi } from "../agents/embedded-agent-helpers.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { FallbackNoticeState } from "../status/fallback-notice-state.js";
import type { RuntimeFallbackAttempt } from "./reply/agent-runner-execution.types.js";

const FALLBACK_REASON_PART_MAX = 80;
const TRANSIENT_FALLBACK_REASONS = new Set([
  "rate_limit",
  "overloaded",
  "timeout",
  "empty_response",
  "no_error_details",
  "unclassified",
]);
const TRANSIENT_ERROR_DETAIL_HINT_RE =
  /\b(?:429|5\d\d|too many requests|usage limit|quota|try again in|retry[- ]after|seconds?|minutes?|hours?|temporarily unavailable|overloaded|service unavailable|throttl\w*)\b/i;

function truncateFallbackReasonPart(value: string): string {
  return truncateWithMarker(value.replace(/\s+/g, " ").trim(), FALLBACK_REASON_PART_MAX, {
    marker: "…",
    reserve: 1,
    trimEnd: true,
  });
}

function formatFallbackAttemptErrorPreview(attempt: RuntimeFallbackAttempt): string | undefined {
  const rawError = attempt.error?.trim();
  if (!rawError) {
    return undefined;
  }
  if (!attempt.reason || !TRANSIENT_FALLBACK_REASONS.has(attempt.reason)) {
    return undefined;
  }
  // Only expose transient-looking raw details; permanent/auth errors can leak noisy provider text.
  if (!TRANSIENT_ERROR_DETAIL_HINT_RE.test(rawError)) {
    return undefined;
  }
  const formatted = formatRawAssistantErrorForUi(rawError)
    .replace(/^⚠️\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!formatted || /unknown error/i.test(formatted)) {
    return undefined;
  }
  return formatted;
}

function formatFallbackAttemptReason(attempt: RuntimeFallbackAttempt): string {
  const errorPreview = formatFallbackAttemptErrorPreview(attempt);
  if (errorPreview) {
    return errorPreview;
  }
  const reason = attempt.reason?.trim();
  if (reason) {
    return reason.replace(/_/g, " ");
  }
  const code = attempt.code?.trim();
  if (code) {
    return code;
  }
  if (typeof attempt.status === "number") {
    return `HTTP ${attempt.status}`;
  }
  return truncateFallbackReasonPart(attempt.error || "error");
}

function buildFallbackReasonSummary(attempts: RuntimeFallbackAttempt[]): string {
  const firstAttempt = attempts[0];
  const firstReason = firstAttempt
    ? formatFallbackAttemptReason(firstAttempt)
    : "selected model unavailable";
  const moreAttempts = attempts.length > 1 ? ` (+${attempts.length - 1} more attempts)` : "";
  return `${truncateFallbackReasonPart(firstReason)}${moreAttempts}`;
}

/** Builds the visible notice shown when runtime falls back from the selected model. */
export function buildFallbackNotice(params: {
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  attempts: RuntimeFallbackAttempt[];
  cfg?: OpenClawConfig;
}): string | null {
  const selected = buildModelCatalogRef(params.selectedProvider, params.selectedModel);
  const active = buildModelCatalogRef(params.activeProvider, params.activeModel);
  if (areRuntimeModelRefsEquivalent(selected, active, { config: params.cfg })) {
    return null;
  }
  const reasonSummary = buildFallbackReasonSummary(params.attempts);
  return `↪️ Model Fallback: ${active} (selected ${selected}; ${reasonSummary})`;
}

/** Builds the visible notice shown after a successful embedded provider-policy retry. */
export function buildProviderPolicyRetryNotice(params: {
  provider: string;
  model: string;
  cfg?: OpenClawConfig;
}): string {
  const target = buildModelCatalogRef(params.provider, params.model);
  const label = areRuntimeModelRefsEquivalent(target, "openai/gpt-daybreak-blue-latest", {
    config: params.cfg,
  })
    ? "Daybreak"
    : target;
  return `↪️ Retried on ${label}`;
}

/** Builds the visible notice shown when runtime returns to the selected model. */
export function buildFallbackClearedNotice(params: {
  selectedProvider: string;
  selectedModel: string;
  previousActiveModel?: string;
}): string {
  const selected = buildModelCatalogRef(params.selectedProvider, params.selectedModel);
  const previous = normalizeOptionalString(params.previousActiveModel);
  if (previous && previous !== selected) {
    return `↪️ Model Fallback cleared: ${selected} (was ${previous})`;
  }
  return `↪️ Model Fallback cleared: ${selected}`;
}

/** Resolves fallback state transitions and the next persisted notice-state fields. */
export function resolveFallbackTransition(params: {
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  attempts: RuntimeFallbackAttempt[];
  state?: FallbackNoticeState;
  cfg?: OpenClawConfig;
}) {
  const selectedModelRef = buildModelCatalogRef(params.selectedProvider, params.selectedModel);
  const activeModelRef = buildModelCatalogRef(params.activeProvider, params.activeModel);
  const previousState = {
    selectedModel: normalizeOptionalString(params.state?.fallbackNotice?.selectedModel),
    activeModel: normalizeOptionalString(params.state?.fallbackNotice?.activeModel),
    reason: normalizeOptionalString(params.state?.fallbackNotice?.reason),
  };
  const comparisonOptions = { config: params.cfg };
  const fallbackActive = !areRuntimeModelRefsEquivalent(
    selectedModelRef,
    activeModelRef,
    comparisonOptions,
  );
  const fallbackTransitioned =
    fallbackActive &&
    (previousState.selectedModel !== selectedModelRef ||
      previousState.activeModel !== activeModelRef);
  const previousStateMatchesCurrent =
    previousState.selectedModel === selectedModelRef &&
    previousState.activeModel === activeModelRef;
  const previousStateWasRealFallback = previousStateMatchesCurrent
    ? fallbackActive
    : Boolean(
        previousState.selectedModel &&
        previousState.activeModel &&
        !areRuntimeModelRefsEquivalent(
          previousState.selectedModel,
          previousState.activeModel,
          comparisonOptions,
        ),
      );
  const fallbackCleared = !fallbackActive && previousStateWasRealFallback;
  const reasonSummary = buildFallbackReasonSummary(params.attempts);
  const attemptSummaries = params.attempts.map((attempt) =>
    truncateFallbackReasonPart(
      `${buildModelCatalogRef(attempt.provider, attempt.model)} ${formatFallbackAttemptReason(attempt)}`,
    ),
  );
  const nextState = fallbackActive
    ? {
        selectedModel: selectedModelRef,
        activeModel: activeModelRef,
        reason: reasonSummary,
      }
    : {
        selectedModel: undefined,
        activeModel: undefined,
        reason: undefined,
      };
  const stateChanged =
    previousState.selectedModel !== nextState.selectedModel ||
    previousState.activeModel !== nextState.activeModel ||
    previousState.reason !== nextState.reason;
  return {
    selectedModelRef,
    activeModelRef,
    fallbackActive,
    fallbackTransitioned,
    fallbackCleared,
    reasonSummary,
    attemptSummaries,
    previousState,
    nextState,
    stateChanged,
  };
}
