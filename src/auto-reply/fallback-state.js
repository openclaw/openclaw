import { formatProviderModelRef } from "./model-runtime.js";
const FALLBACK_REASON_PART_MAX = 80;
export function normalizeFallbackModelRef(value) {
    const trimmed = String(value ?? "").trim();
    return trimmed || undefined;
}
function truncateFallbackReasonPart(value, max = FALLBACK_REASON_PART_MAX) {
    const text = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
export function formatFallbackAttemptReason(attempt) {
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
    const previous = normalizeFallbackModelRef(params.previousActiveModel);
    if (previous && previous !== selected) {
        return `↪️ Model Fallback cleared: ${selected} (was ${previous})`;
    }
    return `↪️ Model Fallback cleared: ${selected}`;
}
export function resolveActiveFallbackState(params) {
    const selected = normalizeFallbackModelRef(params.state?.fallbackNoticeSelectedModel);
    const active = normalizeFallbackModelRef(params.state?.fallbackNoticeActiveModel);
    const reason = normalizeFallbackModelRef(params.state?.fallbackNoticeReason);
    const fallbackActive = params.selectedModelRef !== params.activeModelRef &&
        selected === params.selectedModelRef &&
        active === params.activeModelRef;
    return {
        active: fallbackActive,
        reason: fallbackActive ? reason : undefined,
    };
}
export function resolveFallbackTransition(params) {
    const selectedModelRef = formatProviderModelRef(params.selectedProvider, params.selectedModel);
    const activeModelRef = formatProviderModelRef(params.activeProvider, params.activeModel);
    const previousState = {
        selectedModel: normalizeFallbackModelRef(params.state?.fallbackNoticeSelectedModel),
        activeModel: normalizeFallbackModelRef(params.state?.fallbackNoticeActiveModel),
        reason: normalizeFallbackModelRef(params.state?.fallbackNoticeReason),
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
