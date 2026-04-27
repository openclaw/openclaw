import { formatRawAssistantErrorForUi } from "../agents/pi-embedded-helpers.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatProviderModelRef } from "./model-runtime.js";
export { resolveActiveFallbackState, } from "../status/fallback-notice-state.js";
const FALLBACK_REASON_PART_MAX = 80;
const TRANSIENT_FALLBACK_REASONS = new Set(["rate_limit", "overloaded", "timeout"]);
const TRANSIENT_ERROR_DETAIL_HINT_RE = /\b(?:429|5\d\d|too many requests|usage limit|quota|try again in|retry[- ]after|seconds?|minutes?|hours?|temporarily unavailable|overloaded|service unavailable|throttl)\b/i;
function truncateFallbackReasonPart(value, max = FALLBACK_REASON_PART_MAX) {
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
function formatFallbackAttemptErrorPreview(attempt) {
    const rawError = attempt.error?.trim();
    if (!rawError) {
        return undefined;
    }
    if (!attempt.reason || !TRANSIENT_FALLBACK_REASONS.has(attempt.reason)) {
        return undefined;
    }
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
export function formatFallbackAttemptReason(attempt) {
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
function formatFallbackAttemptSummary(attempt) {
    return `${formatProviderModelRef(attempt.provider, attempt.model)} ${formatFallbackAttemptReason(attempt)}`;
}
export function buildFallbackReasonSummary(attempts) {
    const firstAttempt = attempts[0];
    const firstReason = firstAttempt
        ? formatFallbackAttemptReason(firstAttempt)
        : "selected model unavailable";
    const moreAttempts = attempts.length > 1 ? ` (+${attempts.length - 1} more attempts)` : "";
    return `${truncateFallbackReasonPart(firstReason)}${moreAttempts}`;
}
export function buildFallbackAttemptSummaries(attempts) {
    return attempts.map((attempt) => truncateFallbackReasonPart(formatFallbackAttemptSummary(attempt)));
}
export function buildFallbackNotice(params) {
    const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
    const active = formatProviderModelRef(params.activeProvider, params.activeModel);
    if (selected === active) {
        return null;
    }
    const reasonSummary = buildFallbackReasonSummary(params.attempts);
    return `↪️ Model Fallback: ${active} (selected ${selected}; ${reasonSummary})`;
}
export function buildFallbackClearedNotice(params) {
    const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
    const previous = normalizeOptionalString(params.previousActiveModel);
    if (previous && previous !== selected) {
        return `↪️ Model Fallback cleared: ${selected} (was ${previous})`;
    }
    return `↪️ Model Fallback cleared: ${selected}`;
}
export function resolveFallbackTransition(params) {
    const selectedModelRef = formatProviderModelRef(params.selectedProvider, params.selectedModel);
    const activeModelRef = formatProviderModelRef(params.activeProvider, params.activeModel);
    const previousState = {
        selectedModel: normalizeOptionalString(params.state?.fallbackNoticeSelectedModel),
        activeModel: normalizeOptionalString(params.state?.fallbackNoticeActiveModel),
        reason: normalizeOptionalString(params.state?.fallbackNoticeReason),
    };
    const fallbackActive = selectedModelRef !== activeModelRef;
    const fallbackTransitioned = fallbackActive &&
        (previousState.selectedModel !== selectedModelRef ||
            previousState.activeModel !== activeModelRef);
    const fallbackCleared = !fallbackActive && Boolean(previousState.selectedModel || previousState.activeModel);
    const reasonSummary = buildFallbackReasonSummary(params.attempts);
    const attemptSummaries = buildFallbackAttemptSummaries(params.attempts);
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
    const stateChanged = previousState.selectedModel !== nextState.selectedModel ||
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
