/**
 * Tool-argument sanitize guard for gemma-style local models that leak
 * sentinel tokens or HTML tags into tool_call arguments. P2.18.
 *
 * Background: 2026-05-21 13:45 KST incident reproduced a new failure
 * pattern that earlier fixes did not address:
 *
 *   gemma assistantText (jsonl L196, L216):
 *     "<<|tool|> bash {"command":"./person.sh add 이서현 -- ..."
 *   gemma toolCall args (jsonl L218):
 *     {"command":"./person.sh add 이서현 -- ... </code>"}
 *   gemma toolResult (jsonl L219):
 *     "syntax error near unexpected token `<'"
 *   gemma next assistantText (jsonl L220):
 *     "아, 미안해! ... 다시 시도합니다"
 *   gemma actual retry within 10s: NONE
 *
 * The model's text channel leaks markup tokens (sentinel "<<|...|>"
 * and HTML "</code>") and the tool channel inherits the same noise
 * because the sampler does not separate role from token surface form.
 * Sanitize.ts (P2.11/P2.16) handles the assistantText channel only;
 * tool_call arguments are a distinct emission path that bypasses it.
 *
 * This guard runs on the stream pipeline, identical placement to
 * P2.14 hallucination-guard and the xAI HTML-entity decoder, and
 * sanitizes string fields in tool_call arguments in place before the
 * runtime dispatches the tool.
 *
 * Three sanitize rules (each independently env-gated):
 *   R1. sentinel  : remove "<<|...|>" and "<|...|>" payloads
 *   R2. html-tag  : remove "</tag>" / "<tag>" / "<tag attr=...>"
 *   R3. balance-q : if a string contains an odd number of unescaped
 *                   double quotes, append one "\"" to balance it
 *
 * False-negative companion guard: when the assistant says "다시
 * 시도합니다" / "retry" after a tool failure but never actually
 * re-emits a tool_call within windowMs, emit a warn log entry. The
 * 13:45 incident showed the model promising a retry it never made,
 * which is itself a signal of sampler confusion.
 *
 * The guard is gated by OPENCLAW_TOOL_ARG_SANITIZE_GUARD_ENABLED and
 * applies to all agents (no agent-id whitelist), since the failure is
 * a tokenizer property not specific to gemma. Set
 * OPENCLAW_TOOL_ARG_SANITIZE_GUARD_ENABLED=0 to disable.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/tool-arg-sanitize-guard");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENV_ENABLED = "OPENCLAW_TOOL_ARG_SANITIZE_GUARD_ENABLED";
const ENV_REMOVE_SENTINEL = "OPENCLAW_TOOL_ARG_SANITIZE_REMOVE_SENTINEL";
const ENV_REMOVE_HTML_TAGS = "OPENCLAW_TOOL_ARG_SANITIZE_REMOVE_HTML_TAGS";
const ENV_BALANCE_QUOTE = "OPENCLAW_TOOL_ARG_SANITIZE_BALANCE_QUOTE";
const ENV_HTML_ALLOWLIST = "OPENCLAW_TOOL_ARG_SANITIZE_HTML_ALLOWLIST";
const ENV_MAX_FIELD_LEN = "OPENCLAW_TOOL_ARG_SANITIZE_MAX_FIELD_LEN";

const ENV_FN_GUARD_ENABLED = "OPENCLAW_FALSE_NEGATIVE_GUARD_ENABLED";
const ENV_FN_GUARD_MODE = "OPENCLAW_FALSE_NEGATIVE_GUARD_MODE";
const ENV_FN_GUARD_WINDOW_MS = "OPENCLAW_FALSE_NEGATIVE_GUARD_WINDOW_MS";

const DEFAULT_SANITIZED_FIELDS = [
  "command",
  "url",
  "prompt",
  "text",
  "body",
  "content",
  "message",
  "query",
] as const;

const DEFAULT_MAX_FIELD_LEN = 65536;
const DEFAULT_FN_WINDOW_MS = 10000;

export type ToolArgSanitizeConfig = {
  enabled: boolean;
  removeSentinel: boolean;
  removeHtmlTags: boolean;
  balanceQuote: boolean;
  htmlAllowlist: ReadonlySet<string>;
  maxFieldLen: number;
};

export type FalseNegativeGuardMode = "warn" | "none";

export type FalseNegativeGuardConfig = {
  enabled: boolean;
  mode: FalseNegativeGuardMode;
  windowMs: number;
};

function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const v = String(value).trim().toLowerCase();
  if (v === "") {
    return defaultValue;
  }
  if (v === "0" || v === "false" || v === "no" || v === "off") {
    return false;
  }
  if (v === "1" || v === "true" || v === "yes" || v === "on") {
    return true;
  }
  return defaultValue;
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const n = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return defaultValue;
  }
  return n;
}

function parseAllowlistEnv(value: string | undefined): ReadonlySet<string> {
  if (!value) {
    return new Set<string>();
  }
  return new Set(
    String(value)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): ToolArgSanitizeConfig {
  return {
    enabled: parseBoolEnv(env[ENV_ENABLED], true),
    removeSentinel: parseBoolEnv(env[ENV_REMOVE_SENTINEL], true),
    removeHtmlTags: parseBoolEnv(env[ENV_REMOVE_HTML_TAGS], true),
    balanceQuote: parseBoolEnv(env[ENV_BALANCE_QUOTE], true),
    htmlAllowlist: parseAllowlistEnv(env[ENV_HTML_ALLOWLIST]),
    maxFieldLen: parseIntEnv(env[ENV_MAX_FIELD_LEN], DEFAULT_MAX_FIELD_LEN),
  };
}

export function readFalseNegativeGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): FalseNegativeGuardConfig {
  const rawMode = String(env[ENV_FN_GUARD_MODE] ?? "warn")
    .trim()
    .toLowerCase();
  const mode: FalseNegativeGuardMode = rawMode === "none" ? "none" : "warn";
  return {
    enabled: parseBoolEnv(env[ENV_FN_GUARD_ENABLED], true),
    mode,
    windowMs: parseIntEnv(env[ENV_FN_GUARD_WINDOW_MS], DEFAULT_FN_WINDOW_MS),
  };
}

// ---------------------------------------------------------------------------
// Sanitize primitives (pure, no I/O)
// ---------------------------------------------------------------------------

// R1 sentinel: "<<|...|>" then "<|...|>". Inner body bans pipe, lt, gt.
// Bounded length 0..32 to avoid runaway regex backtracking on edge inputs.
const RE_SENTINEL_DOUBLE = /<<\|[^|<>]{0,32}\|>/g;
const RE_SENTINEL_SINGLE = /<\|[^|<>]{0,32}\|>/g;

// R2 html-tag: matches "</tag>", "<tag>", "<tag attr=value ...>".
// Inner attr region bounded to 256 chars and may not contain "<" or ">".
const RE_HTML_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]{0,32})(?:\s[^<>]{0,256})?>/g;

// R3 unescaped double quote counter (ignore \" escapes).
const RE_UNESCAPED_DQUOTE = /(?<!\\)"/g;

export type SanitizeMutation = {
  field: string;
  rule: "sentinel" | "html-tag" | "balance-quote" | "truncate";
  beforeLen: number;
  afterLen: number;
  sample?: string;
};

export type SanitizeStringResult = {
  value: string;
  mutations: SanitizeMutation[];
};

export function sanitizeString(
  input: string,
  field: string,
  cfg: ToolArgSanitizeConfig,
): SanitizeStringResult {
  const mutations: SanitizeMutation[] = [];
  let current = input;

  if (cfg.removeSentinel) {
    const before = current;
    const next = current.replace(RE_SENTINEL_DOUBLE, "").replace(RE_SENTINEL_SINGLE, "");
    if (next !== before) {
      mutations.push({
        field,
        rule: "sentinel",
        beforeLen: before.length,
        afterLen: next.length,
        sample: before.slice(0, 64),
      });
      current = next;
    }
  }

  if (cfg.removeHtmlTags) {
    const before = current;
    const allowlist = cfg.htmlAllowlist;
    const next = before.replace(RE_HTML_TAG, (match, tagName: string) => {
      if (allowlist.has(String(tagName).toLowerCase())) {
        return match;
      }
      return "";
    });
    if (next !== before) {
      mutations.push({
        field,
        rule: "html-tag",
        beforeLen: before.length,
        afterLen: next.length,
        sample: before.slice(0, 64),
      });
      current = next;
    }
  }

  if (cfg.balanceQuote) {
    const before = current;
    const matches = before.match(RE_UNESCAPED_DQUOTE);
    const count = matches ? matches.length : 0;
    if (count % 2 === 1) {
      const next = `${before}"`;
      mutations.push({
        field,
        rule: "balance-quote",
        beforeLen: before.length,
        afterLen: next.length,
        sample: before.slice(-64),
      });
      current = next;
    }
  }

  if (current.length > cfg.maxFieldLen) {
    const before = current;
    const next = current.slice(0, cfg.maxFieldLen);
    mutations.push({
      field,
      rule: "truncate",
      beforeLen: before.length,
      afterLen: next.length,
    });
    current = next;
  }

  return { value: current, mutations };
}

export type SanitizeArgsResult = {
  args: Record<string, unknown>;
  mutations: SanitizeMutation[];
  changed: boolean;
};

export function sanitizeToolArgs(
  args: Record<string, unknown> | null | undefined,
  toolName: string,
  cfg: ToolArgSanitizeConfig = readEnvConfig(),
): SanitizeArgsResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { args: {}, mutations: [], changed: false };
  }
  if (!cfg.enabled) {
    return { args, mutations: [], changed: false };
  }

  const mutations: SanitizeMutation[] = [];
  const result: Record<string, unknown> = {};
  let changed = false;

  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      result[key] = value;
      continue;
    }
    if (!DEFAULT_SANITIZED_FIELDS.includes(key as (typeof DEFAULT_SANITIZED_FIELDS)[number])) {
      // Also sanitize any string field whose value looks contaminated.
      const looksContaminated =
        RE_SENTINEL_DOUBLE.test(value) || RE_SENTINEL_SINGLE.test(value) || RE_HTML_TAG.test(value);
      // Reset global regex state after .test().
      RE_SENTINEL_DOUBLE.lastIndex = 0;
      RE_SENTINEL_SINGLE.lastIndex = 0;
      RE_HTML_TAG.lastIndex = 0;
      if (!looksContaminated) {
        result[key] = value;
        continue;
      }
    }
    const sanitized = sanitizeString(value, key, cfg);
    if (sanitized.mutations.length > 0) {
      changed = true;
      for (const m of sanitized.mutations) {
        mutations.push(m);
      }
      log.warn(
        `tool-arg-sanitize tool=${toolName} field=${key} rules=${sanitized.mutations.map((m) => m.rule).join(",")} before=${value.length} after=${sanitized.value.length}`,
      );
    }
    result[key] = sanitized.value;
  }

  return { args: result, mutations, changed };
}

// ---------------------------------------------------------------------------
// Stream wrapper - sanitize tool_call arguments in messages emitted by
// the model stream, in place. Mirrors decodeXaiToolCallArgumentsInMessage.
// ---------------------------------------------------------------------------

export function sanitizeToolCallArgumentsInMessage(
  message: unknown,
  cfg: ToolArgSanitizeConfig = readEnvConfig(),
): boolean {
  if (!cfg.enabled) {
    return false;
  }
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let anyChanged = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown; name?: unknown };
    const t = typedBlock.type;
    const isToolCall = t === "toolCall" || t === "toolUse" || t === "functionCall";
    if (!isToolCall) {
      continue;
    }
    const args = typedBlock.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      continue;
    }
    const toolName = typeof typedBlock.name === "string" ? typedBlock.name : "unknown";
    const res = sanitizeToolArgs(args as Record<string, unknown>, toolName, cfg);
    if (res.changed) {
      typedBlock.arguments = res.args;
      anyChanged = true;
    }
  }
  return anyChanged;
}

export type StreamLike = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

export function wrapStreamSanitizeToolCallArguments<S extends StreamLike>(
  stream: S,
  cfg: ToolArgSanitizeConfig = readEnvConfig(),
): S {
  if (!cfg.enabled) {
    return stream;
  }
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    sanitizeToolCallArgumentsInMessage(message, cfg);
    return message;
  };
  const originalAsyncIterator = (
    stream as unknown as {
      [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
    }
  )[Symbol.asyncIterator].bind(stream);
  (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[
    Symbol.asyncIterator
  ] = function () {
    const iterator = originalAsyncIterator();
    return {
      async next() {
        const result = await iterator.next();
        if (!result.done && result.value && typeof result.value === "object") {
          const event = result.value as { partial?: unknown; message?: unknown };
          sanitizeToolCallArgumentsInMessage(event.partial, cfg);
          sanitizeToolCallArgumentsInMessage(event.message, cfg);
        }
        return result;
      },
      async return(value?: unknown) {
        return iterator.return?.(value) ?? { done: true as const, value: undefined };
      },
      async throw(error?: unknown) {
        return iterator.throw?.(error) ?? { done: true as const, value: undefined };
      },
    };
  };
  return stream;
}

export type StreamFn = (...args: unknown[]) => unknown;

export function wrapStreamFnSanitizeToolCallArguments(
  baseFn: StreamFn,
  cfg: ToolArgSanitizeConfig = readEnvConfig(),
): StreamFn {
  if (!cfg.enabled) {
    return baseFn;
  }
  return (...args: unknown[]) => {
    const maybeStream = baseFn(...args);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return (maybeStream as Promise<StreamLike>).then((stream) =>
        wrapStreamSanitizeToolCallArguments(stream, cfg),
      );
    }
    return wrapStreamSanitizeToolCallArguments(maybeStream as StreamLike, cfg);
  };
}

// ---------------------------------------------------------------------------
// False-negative guard: assistant promises "다시 시도" but does not retry
// ---------------------------------------------------------------------------

const RETRY_PROMISE_PATTERNS: ReadonlyArray<RegExp> = [
  /다시\s*시도/i,
  /재\s*시도/i,
  /\bretry\b/i,
  /\btry\s+again\b/i,
  /again\s*\.\.\./i,
];

export function looksLikeRetryPromise(text: string): boolean {
  if (!text || typeof text !== "string") {
    return false;
  }
  for (const re of RETRY_PROMISE_PATTERNS) {
    if (re.test(text)) {
      return true;
    }
  }
  return false;
}

export type FalseNegativeEvent =
  | { kind: "toolFailed"; at: number; toolName: string; error: string }
  | { kind: "assistantText"; at: number; text: string }
  | { kind: "toolCall"; at: number; toolName: string };

export type FalseNegativeDetection =
  | { detected: false }
  | {
      detected: true;
      failedToolName: string;
      promiseAt: number;
      windowMs: number;
      action: "warn" | "none";
    };

export function detectFalseNegativePromise(
  events: ReadonlyArray<FalseNegativeEvent>,
  cfg: FalseNegativeGuardConfig = readFalseNegativeGuardConfig(),
): FalseNegativeDetection {
  if (!cfg.enabled) {
    return { detected: false };
  }
  if (!events || events.length === 0) {
    return { detected: false };
  }

  // Walk forward: find toolFailed → assistantText(retry promise) → toolCall?
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind !== "toolFailed") {
      continue;
    }
    const failedTool = ev.toolName;
    // Find the next assistantText after this toolFailed event.
    let promiseAt: number | null = null;
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (next.kind === "assistantText") {
        if (looksLikeRetryPromise(next.text)) {
          promiseAt = next.at;
        }
        break;
      }
      if (next.kind === "toolCall") {
        // A real retry preempts the promise check.
        break;
      }
    }
    if (promiseAt === null) {
      continue;
    }
    // Check whether a toolCall follows within windowMs.
    let retried = false;
    for (let k = i + 1; k < events.length; k++) {
      const next = events[k];
      if (next.kind === "toolCall" && next.at - promiseAt <= cfg.windowMs) {
        retried = true;
        break;
      }
      if (next.at - promiseAt > cfg.windowMs) {
        break;
      }
    }
    if (!retried) {
      const action: "warn" | "none" = cfg.mode === "warn" ? "warn" : "none";
      if (action === "warn") {
        log.warn(
          `false-negative-promise detected failedTool=${failedTool} promiseAt=${promiseAt} windowMs=${cfg.windowMs} no retry within window`,
        );
      }
      return {
        detected: true,
        failedToolName: failedTool,
        promiseAt,
        windowMs: cfg.windowMs,
        action,
      };
    }
  }
  return { detected: false };
}
