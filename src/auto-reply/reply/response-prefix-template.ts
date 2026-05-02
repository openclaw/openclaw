import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format-shared.js";

/**
 * Template interpolation for response metadata templates such as
 * `messages.responsePrefix` and `messages.responseFooter`.
 *
 * Supports variables like `{model}`, `{provider}`, `{thinkingLevel}`, etc.
 * Variables are case-insensitive and unresolved ones remain as literal text.
 */

export type ResponseTemplateContext = {
  /** Short model name (e.g., "gpt-5.4", "claude-opus-4-6") */
  model?: string;
  /** Full model ID including provider (e.g., "openai/gpt-5.5") */
  modelFull?: string;
  /** Provider name (e.g., "openai-codex", "anthropic") */
  provider?: string;
  /** Current thinking level (e.g., "high", "low", "off") */
  thinkingLevel?: string;
  /** Agent identity name */
  identityName?: string;
  /** User-facing alias for thinking level. */
  effort?: string;
  /** Per-reply prompt/input tokens. */
  inputTokens?: number;
  /** Per-reply completion/output tokens. */
  outputTokens?: number;
  /** Per-reply total tokens. */
  totalTokens?: number;
  /** Per-reply cache read tokens. */
  cacheReadTokens?: number;
  /** Per-reply cache write tokens. */
  cacheWriteTokens?: number;
  /** Fresh persisted session context usage. */
  contextUsedTokens?: number;
  /** Active context window/token limit. */
  contextMaxTokens?: number;
  /** Fresh persisted context utilization percentage. */
  contextPercent?: number;
  /** Session key when available. */
  sessionKey?: string;
  /** Estimated per-reply cost in USD when pricing is available. */
  estimatedCostUsd?: number;
  /** Fully formatted built-in usage line, when available. */
  usageLine?: string;
};

export type ResponsePrefixContext = ResponseTemplateContext;

// Regex pattern for template variables: {variableName} or {variable.name}
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;

function formatCompactTokenValue(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? formatTokenCount(value)
    : undefined;
}

function formatIntegerValue(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}` : undefined;
}

const USAGE_AWARE_TEMPLATE_VARS = new Set([
  "input",
  "inputtokens",
  "output",
  "outputtokens",
  "total",
  "totaltokens",
  "cacheread",
  "cachereadtokens",
  "cachewrite",
  "cachewritetokens",
  "context",
  "contextused",
  "contextusedtokens",
  "contextmax",
  "contextmaxtokens",
  "contextwindow",
  "contextpercent",
  "usage",
  "usageline",
]);

const PREFIX_SOFT_MISSING_TEMPLATE_VARS = new Set([
  ...USAGE_AWARE_TEMPLATE_VARS,
  "cost",
  "estimatedcost",
  "estimatedcostusd",
  "session",
  "sessionkey",
]);

const LATE_BOUND_TEMPLATE_VARS = new Set(PREFIX_SOFT_MISSING_TEMPLATE_VARS);

/**
 * Interpolate template variables in a response metadata string.
 *
 * @param template - The template string with `{variable}` placeholders
 * @param context - Context object with values for interpolation
 * @returns The interpolated string, or undefined if template is undefined
 *
 * @example
 * resolveResponseTemplate("[{model} | think:{thinkingLevel}]", {
 *   model: "gpt-5.4",
 *   thinkingLevel: "high"
 * })
 * // Returns: "[gpt-5.4 | think:high]"
 */
export function resolveResponseTemplate(
  template: string | undefined,
  context: ResponseTemplateContext,
): string | undefined {
  if (!template) {
    return undefined;
  }

  return template.replace(TEMPLATE_VAR_PATTERN, (match, varName: string) => {
    const normalizedVar = normalizeLowercaseStringOrEmpty(varName);

    switch (normalizedVar) {
      case "model":
        return context.model ?? match;
      case "modelfull":
        return context.modelFull ?? match;
      case "provider":
        return context.provider ?? match;
      case "thinkinglevel":
      case "think":
        return context.thinkingLevel ?? context.effort ?? match;
      case "effort":
        return context.effort ?? context.thinkingLevel ?? match;
      case "identity.name":
      case "identityname":
        return context.identityName ?? match;
      case "input":
      case "inputtokens":
        return formatCompactTokenValue(context.inputTokens) ?? match;
      case "output":
      case "outputtokens":
        return formatCompactTokenValue(context.outputTokens) ?? match;
      case "total":
      case "totaltokens":
        return formatCompactTokenValue(context.totalTokens) ?? match;
      case "cacheread":
      case "cachereadtokens":
        return formatCompactTokenValue(context.cacheReadTokens) ?? match;
      case "cachewrite":
      case "cachewritetokens":
        return formatCompactTokenValue(context.cacheWriteTokens) ?? match;
      case "context":
      case "contextused":
      case "contextusedtokens":
        return formatCompactTokenValue(context.contextUsedTokens) ?? match;
      case "contextmax":
      case "contextmaxtokens":
      case "contextwindow":
        return formatCompactTokenValue(context.contextMaxTokens) ?? match;
      case "contextpercent":
        return formatIntegerValue(context.contextPercent) ?? match;
      case "cost":
      case "estimatedcost":
      case "estimatedcostusd":
        return formatUsd(context.estimatedCostUsd) ?? match;
      case "usage":
      case "usageline":
        return context.usageLine ?? match;
      case "session":
      case "sessionkey":
        return context.sessionKey ?? match;
      default:
        // Leave unrecognized variables as-is
        return match;
    }
  });
}

/**
 * Extract short model name from a full model string.
 *
 * Strips:
 * - Provider prefix (e.g., "openai/" from "openai/gpt-5.4")
 * - Date suffixes (e.g., "-20260205" from "claude-opus-4-6-20260205")
 * - Common version suffixes (e.g., "-latest")
 *
 * @example
 * extractShortModelName("openai/gpt-5.5") // "gpt-5.5"
 * extractShortModelName("claude-opus-4-6-20260205") // "claude-opus-4-6"
 * extractShortModelName("gpt-5.4-latest") // "gpt-5.4"
 */
export function extractShortModelName(fullModel: string): string {
  // Strip provider prefix
  const slash = fullModel.lastIndexOf("/");
  const modelPart = slash >= 0 ? fullModel.slice(slash + 1) : fullModel;

  // Strip date suffixes (YYYYMMDD format)
  return modelPart.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

function stripSoftMissingPrefixPlaceholders(text: string): string {
  let removedAny = false;
  const stripped = text.replace(TEMPLATE_VAR_PATTERN, (match, varName: string) => {
    const normalizedVar = normalizeLowercaseStringOrEmpty(varName);
    if (PREFIX_SOFT_MISSING_TEMPLATE_VARS.has(normalizedVar)) {
      removedAny = true;
      return "";
    }
    return match;
  });

  if (!removedAny) {
    return text;
  }

  return stripped
    .split("\n")
    .map((line) => line.replace(/[ 	]{2,}/g, " ").replace(/^[ 	]+|[ 	]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function resolveResponsePrefixTemplate(
  template: string | undefined,
  context: ResponsePrefixContext,
): string | undefined {
  const resolved = resolveResponseTemplate(template, context);
  return resolved ? stripSoftMissingPrefixPlaceholders(resolved) : resolved;
}

/**
 * Return the normalized template variables referenced by a template string.
 */
export function listTemplateVariables(template: string | undefined): string[] {
  if (!template) {
    return [];
  }
  TEMPLATE_VAR_PATTERN.lastIndex = 0;
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_VAR_PATTERN.exec(template))) {
    const normalized = normalizeLowercaseStringOrEmpty(match[1]);
    if (normalized) {
      vars.add(normalized);
    }
  }
  return [...vars];
}

/**
 * Check if a template string contains any template variables.
 */
export function hasTemplateVariables(template: string | undefined): boolean {
  return listTemplateVariables(template).length > 0;
}

/**
 * True when a template already consumes usage/context placeholders and should
 * replace the separate built-in usage footer line.
 */
export function hasUsageTemplateVariables(template: string | undefined): boolean {
  return listTemplateVariables(template).some((name) => USAGE_AWARE_TEMPLATE_VARS.has(name));
}

export function hasLateBoundTemplateVariables(template: string | undefined): boolean {
  return listTemplateVariables(template).some((name) => LATE_BOUND_TEMPLATE_VARS.has(name));
}
