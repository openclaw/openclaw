/**
 * Outbound footer + context-warning processor.
 *
 * Background: agents have been asked via prompt to append a "status footer"
 * like `📚 X% (Xk/200k) · 🧹 N compactions · 🧠 model` to outbound messages.
 * The model fabricates these numbers (multiple production regressions logged).
 * The runtime knows the truth and should write it - or at minimum strip any
 * model-written variant so users never see fabricated runtime telemetry.
 *
 * This module is pure: no I/O, no config loading, no session lookups.
 * Callers source live values from session state and pass them in.
 */

/**
 * Matches a model-written status footer of the form
 *   `📚 5% (10k/200k) · 🧹 0 compactions · 🧠 anthropic/claude-opus-4-7`
 *
 * Intentionally permissive on whitespace and the trailing model identifier so
 * variants the model invents still get caught. Anchors on the ASCII separators
 * `·` (U+00B7) and the literal " compactions " token plus the leading 📚 emoji.
 *
 * Captures only the footer line itself; surrounding newlines are stripped by
 * the caller wrapper.
 */
const FABRICATED_FOOTER_RE =
  /\u{1F4DA}\s*\d+%\s*\(\s*\d+(?:\.\d+)?k?\s*\/\s*\d+(?:\.\d+)?k?\s*\)\s*[·•]\s*\u{1F9F9}\s*\d+\s*compactions?\s*[·•]\s*\u{1F9E0}\s*[^\n]+/giu;

export type StripFabricatedFooterResult = {
  text: string;
  changed: boolean;
};

/**
 * Strip any model-written status footer from text. Removes the footer line
 * and any whitespace immediately surrounding it on the same trailing block.
 */
export function stripFabricatedFooter(text: string): StripFabricatedFooterResult {
  if (!text) {
    return { text, changed: false };
  }
  if (!text.includes("\u{1F4DA}")) {
    return { text, changed: false };
  }
  let stripped = text.replace(FABRICATED_FOOTER_RE, "");
  if (stripped === text) {
    return { text, changed: false };
  }
  // Collapse the dangling whitespace/newlines the strip leaves behind so the
  // message body still looks clean.
  stripped = stripped.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return { text: stripped, changed: true };
}

export type FooterRenderVars = {
  /** Live context tokens used (sourced from session state, not the model). */
  contextTokens?: number;
  /** Live context window limit for the active model. */
  contextLimit?: number;
  /** Live compaction count for this session. */
  compactions?: number;
  /** Active model alias / identifier. */
  modelAlias?: string;
};

const TOKEN_RE = /\{\s*([a-z_][a-z0-9_]*)\s*\}/gi;

function formatTokensK(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0k";
  }
  // Round to nearest k, keep one decimal only if below 10k for readability.
  const k = value / 1000;
  if (k >= 10) {
    return `${Math.round(k)}k`;
  }
  return `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

export function computeContextPercent(
  contextTokens?: number,
  contextLimit?: number,
): number | undefined {
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens)) {
    return undefined;
  }
  if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit) || contextLimit <= 0) {
    return undefined;
  }
  return Math.round((contextTokens / contextLimit) * 100);
}

/**
 * Render a footer template, substituting `{placeholder}` tokens. Unknown
 * tokens are left as the literal `{name}` form so config typos remain visible.
 *
 * Supported placeholders:
 * - `{context_pct}` rendered percentage of context used (integer, no `%`).
 * - `{context_tokens}` current usage in `Nk` form.
 * - `{context_limit}` configured limit in `Nk` form.
 * - `{compactions}` integer compaction count.
 * - `{model_alias}` model alias string.
 */
export function renderFooter(template: string, vars: FooterRenderVars): string {
  if (!template) {
    return "";
  }
  const pct = computeContextPercent(vars.contextTokens, vars.contextLimit);
  const replacements: Record<string, string> = {
    context_pct: pct === undefined ? "?" : String(pct),
    context_tokens:
      typeof vars.contextTokens === "number" ? formatTokensK(vars.contextTokens) : "?",
    context_limit: typeof vars.contextLimit === "number" ? formatTokensK(vars.contextLimit) : "?",
    compactions: typeof vars.compactions === "number" ? String(vars.compactions) : "0",
    model_alias: vars.modelAlias ?? "?",
  };
  return template.replace(TOKEN_RE, (match, rawKey: string) => {
    const key = rawKey.toLowerCase();
    return Object.hasOwn(replacements, key) ? replacements[key]! : match;
  });
}

export type ContextWarningInput = {
  contextTokens?: number;
  contextLimit?: number;
  /** Configured threshold percents (0..100). Empty disables the warning. */
  thresholds: number[];
  /** Thresholds already warned for in this session. */
  alreadyWarned: number[];
};

export type ContextWarningResult = {
  /** New threshold to record (>= prior, never lower). Undefined when no warning fires. */
  thresholdToRecord?: number;
  /** Pre-rendered warning line, ready to prepend. */
  warningLine?: string;
};

/**
 * Decide whether to emit a context-threshold warning. Picks the highest
 * configured threshold the current usage crosses that has not yet been warned
 * about this session. Callers persist `thresholdToRecord` back to session
 * state to enforce once-per-threshold-per-session semantics.
 */
export function evaluateContextWarning(input: ContextWarningInput): ContextWarningResult {
  const pct = computeContextPercent(input.contextTokens, input.contextLimit);
  if (pct === undefined) {
    return {};
  }
  const sortedThresholds = [...input.thresholds]
    .filter((t) => Number.isFinite(t) && t > 0 && t < 1000)
    .sort((a, b) => a - b);
  if (sortedThresholds.length === 0) {
    return {};
  }
  const warnedSet = new Set<number>(input.alreadyWarned ?? []);
  // Find the highest crossed threshold that has not been warned yet.
  let chosen: number | undefined;
  for (const t of sortedThresholds) {
    if (pct >= t && !warnedSet.has(t)) {
      chosen = t;
    }
  }
  if (chosen === undefined) {
    return {};
  }
  return {
    thresholdToRecord: chosen,
    warningLine: `\u26A0\uFE0F Context ${pct}% - consider /new`,
  };
}

export type ProcessOutboundTextInput = {
  text: string;
  footer?: {
    enabled: boolean;
    template: string;
    vars: FooterRenderVars;
  };
  warning?: ContextWarningInput;
};

export type ProcessOutboundTextResult = {
  text: string;
  /** True when the source text contained a model-written footer. */
  strippedFabricatedFooter: boolean;
  /** True when a server-rendered footer was appended. */
  appendedFooter: boolean;
  /** Threshold the caller should persist on session state, if any. */
  warningThresholdRecorded?: number;
  /** True when a warning line was prepended. */
  prependedWarning: boolean;
};

/**
 * Single composite hook used by the outbound pipeline. Strips any fabricated
 * footer, optionally prepends a context-threshold warning, and optionally
 * appends a server-rendered footer.
 *
 * Order is deliberate: stripping happens first so we never mistake a
 * fabricated footer for a configured one. The warning prepends so it always
 * leads the message. The server footer appends last, on its own line.
 */
export function processOutboundText(input: ProcessOutboundTextInput): ProcessOutboundTextResult {
  const stripped = stripFabricatedFooter(input.text ?? "");
  let working = stripped.text;
  let appendedFooter = false;
  let prependedWarning = false;
  let warningThresholdRecorded: number | undefined;

  if (input.warning && input.warning.thresholds.length > 0) {
    const decision = evaluateContextWarning(input.warning);
    if (decision.warningLine) {
      working = working ? `${decision.warningLine}\n${working}` : decision.warningLine;
      prependedWarning = true;
      warningThresholdRecorded = decision.thresholdToRecord;
    }
  }

  if (input.footer && input.footer.enabled && input.footer.template) {
    const rendered = renderFooter(input.footer.template, input.footer.vars);
    if (rendered) {
      working = working ? `${working}\n\n${rendered}` : rendered;
      appendedFooter = true;
    }
  }

  return {
    text: working,
    strippedFabricatedFooter: stripped.changed,
    appendedFooter,
    prependedWarning,
    ...(warningThresholdRecorded === undefined ? {} : { warningThresholdRecorded }),
  };
}
