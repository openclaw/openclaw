import { formatRawAssistantErrorForUi } from "../agents/pi-embedded-helpers.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { FallbackNoticeState } from "../status/fallback-notice-state.js";
import { formatProviderModelRef } from "./model-runtime.js";
import type { RuntimeFallbackAttempt } from "./reply/agent-runner-execution.js";
export {
  resolveActiveFallbackState,
  type FallbackNoticeState,
} from "../status/fallback-notice-state.js";

/**
 * 回退原因部分的最大长度
 */
const FALLBACK_REASON_PART_MAX = 80;

/**
 * 瞬时回退原因集合
 * 这些原因表示暂时性错误，可能稍后重试成功
 */
const TRANSIENT_FALLBACK_REASONS = new Set([
  "rate_limit",
  "overloaded",
  "timeout",
  "empty_response",
  "no_error_details",
  "unclassified",
]);

/**
 * 瞬时错误详情提示正则表达式
 * 用于识别暂时性错误的常见模式
 */
const TRANSIENT_ERROR_DETAIL_HINT_RE =
  /\b(?:429|5\d\d|too many requests|usage limit|quota|try again in|retry[- ]after|seconds?|minutes?|hours?|temporarily unavailable|overloaded|service unavailable|throttl)\b/i;

/**
 * 截断回退原因文本
 * @param value - 要截断的值
 * @param max - 最大长度
 * @returns 截断后的文本，超长时用省略号结尾
 */
function truncateFallbackReasonPart(value: string, max = FALLBACK_REASON_PART_MAX): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * 格式化回退尝试错误预览
 * @param attempt - 运行时回退尝试
 * @returns 格式化的错误预览或undefined
 */
function formatFallbackAttemptErrorPreview(attempt: RuntimeFallbackAttempt): string | undefined {
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

/**
 * 格式化回退尝试原因
 * @param attempt - 运行时回退尝试
 * @returns 可读的原因描述
 */
export function formatFallbackAttemptReason(attempt: RuntimeFallbackAttempt): string {
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

/**
 * 格式化单个回退尝试摘要
 * @param attempt - 运行时回退尝试
 * @returns 提供商模型和原因的摘要字符串
 */
function formatFallbackAttemptSummary(attempt: RuntimeFallbackAttempt): string {
  return `${formatProviderModelRef(attempt.provider, attempt.model)} ${formatFallbackAttemptReason(attempt)}`;
}

/**
 * 构建回退原因摘要
 * @param attempts - 回退尝试列表
 * @returns 格式化的事先原因摘要
 */
export function buildFallbackReasonSummary(attempts: RuntimeFallbackAttempt[]): string {
  const firstAttempt = attempts[0];
  const firstReason = firstAttempt
    ? formatFallbackAttemptReason(firstAttempt)
    : "selected model unavailable";
  const moreAttempts = attempts.length > 1 ? ` (+${attempts.length - 1} more attempts)` : "";
  return `${truncateFallbackReasonPart(firstReason)}${moreAttempts}`;
}

/**
 * 构建所有回退尝试的摘要列表
 * @param attempts - 回退尝试列表
 * @returns 摘要字符串数组
 */
export function buildFallbackAttemptSummaries(attempts: RuntimeFallbackAttempt[]): string[] {
  return attempts.map((attempt) =>
    truncateFallbackReasonPart(formatFallbackAttemptSummary(attempt)),
  );
}

/**
 * 构建回退通知文本
 * @param params - 包含选择和活动提供商/模型及尝试列表的参数
 * @returns 格式化的通知字符串，无变化时返回null
 */
export function buildFallbackNotice(params: {
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  attempts: RuntimeFallbackAttempt[];
}): string | null {
  const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
  const active = formatProviderModelRef(params.activeProvider, params.activeModel);
  if (selected === active) {
    return null;
  }
  const reasonSummary = buildFallbackReasonSummary(params.attempts);
  return `↪️ Model Fallback: ${active} (selected ${selected}; ${reasonSummary})`;
}

/**
 * 构建回退清除通知
 * @param params - 包含选择模型和先前活动模型的参数
 * @returns 格式化的清除通知字符串
 */
export function buildFallbackClearedNotice(params: {
  selectedProvider: string;
  selectedModel: string;
  previousActiveModel?: string;
}): string {
  const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
  const previous = normalizeOptionalString(params.previousActiveModel);
  if (previous && previous !== selected) {
    return `↪️ Model Fallback cleared: ${selected} (was ${previous})`;
  }
  return `↪️ Model Fallback cleared: ${selected}`;
}

/**
 * 已解析的回退转换状态
 */
export type ResolvedFallbackTransition = {
  selectedModelRef: string;
  activeModelRef: string;
  fallbackActive: boolean;
  fallbackTransitioned: boolean;
  fallbackCleared: boolean;
  reasonSummary: string;
  attemptSummaries: string[];
  previousState: {
    selectedModel?: string;
    activeModel?: string;
    reason?: string;
  };
  nextState: {
    selectedModel?: string;
    activeModel?: string;
    reason?: string;
  };
  stateChanged: boolean;
};

/**
 * 解析回退转换状态
 * @param params - 包含提供商、模型、尝试和先前状态的参数
 * @returns 解析后的完整转换状态
 */
export function resolveFallbackTransition(params: {
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  attempts: RuntimeFallbackAttempt[];
  state?: FallbackNoticeState;
}): ResolvedFallbackTransition {
  const selectedModelRef = formatProviderModelRef(params.selectedProvider, params.selectedModel);
  const activeModelRef = formatProviderModelRef(params.activeProvider, params.activeModel);
  const previousState = {
    selectedModel: normalizeOptionalString(params.state?.fallbackNoticeSelectedModel),
    activeModel: normalizeOptionalString(params.state?.fallbackNoticeActiveModel),
    reason: normalizeOptionalString(params.state?.fallbackNoticeReason),
  };
  const fallbackActive = selectedModelRef !== activeModelRef;
  const fallbackTransitioned =
    fallbackActive &&
    (previousState.selectedModel !== selectedModelRef ||
      previousState.activeModel !== activeModelRef);
  const fallbackCleared =
    !fallbackActive && Boolean(previousState.selectedModel || previousState.activeModel);
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
