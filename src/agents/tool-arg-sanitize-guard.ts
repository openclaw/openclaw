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
  // P2.24b (2026-05-22): exec/bash 도구의 표준 변형 필드. command 외에도 cmd, script 누설 가능.
  "cmd",
  "script",
  "url",
  "prompt",
  "text",
  "body",
  "content",
  "message",
  "query",
  // P2.19b (2026-05-21 21:00 KST): path/file_path fields. Live failure case
  // jsonl L34 - model auto-corrected to file_path: "\"notes/p219-retry.md\""
  // (sentinel prefix stripped, but JSON-encoded quotes left a literal dquote
  // file under workspace). Path-style fields get a dedicated quote/sentinel-
  // prefix strip rule via PATH_SANITIZED_FIELDS + sanitizeString isPath opt.
  "file_path",
  "path",
] as const;

// PATH_SANITIZED_FIELDS: subset of fields treated as filesystem paths. They
// receive an extra "R4 path-quote-strip" rule and bypass R3 balance-quote
// (which would corrupt a one-side-unbalanced path by appending a stray dquote).
const PATH_SANITIZED_FIELDS = new Set<string>(["file_path", "path"]);

// EXEC_CMD_SANITIZED_FIELDS (P2.24c, 2026-05-22): fields holding raw shell
// command strings. They receive an extra R5b orphan-prefix strip pass that
// is unsafe to apply globally (would touch markdown body / prose text), but
// is safe and necessary here because shell command syntax never legitimately
// contains a "<|" / "<<|" token.
const EXEC_CMD_SANITIZED_FIELDS = new Set<string>(["command", "cmd", "script"]);

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
// R1.2 open sentinel variant: P2.18.2 (2026-05-21 18:58) live reproduction.
// User sent clonari URL to gemma; model serialized web_fetch args.url as
// "<<|\"|https://clonari.craftbay.io/s/...". The closing ">" of the sentinel
// is dropped and the inner "|" is followed directly by the payload, so neither
// RE_SENTINEL_DOUBLE (requires "|>" terminator) nor RE_SENTINEL_HEREDOC
// ([^|>\s] inner bans pipe) catches it. RE_SENTINEL_OPEN_* matches the open
// form "<<|inner|" or "<|inner|" only when NOT followed by ">" (lookahead
// (?!>) keeps DOUBLE/SINGLE behavior orthogonal — closed forms still flow
// through R1). Inner also bans whitespace so natural "<< foo |" prose is safe.
const RE_SENTINEL_OPEN_DOUBLE = /<<\|[^|<>\s]{0,32}\|(?!>)/g;
const RE_SENTINEL_OPEN_SINGLE = /<\|[^|<>\s]{0,32}\|(?!>)/g;
// R1.3 nested sentinel variant: P2.18.3 (2026-05-21 19:24) live reproduction.
// Model serialized write args.content as "<|<|\"# ...". The outer "<|"
// opens a sentinel marker but inner contains "<" (the second "<|" start),
// so RE_SENTINEL_OPEN_SINGLE inner ban [^|<>\s] rejects "<". Relax inner
// to ban only "|" and whitespace — preserving the {1,64} length cap. False
// positives in natural prose are unlikely because "<...|" with no whitespace
// for up to 64 chars is rare. Length 1+ so empty inner cannot match.
const RE_SENTINEL_NESTED_DOUBLE = /<<\|[^|\s]{1,64}\|(?!>)/g;
const RE_SENTINEL_NESTED_SINGLE = /<\|[^|\s]{1,64}\|(?!>)/g;
// R1.1 heredoc variant: P2.18 TD18-2 (2026-05-21 17:12) reproduced
// "<<//code>" - model serializing "</code>" into args ended up adding an
// extra "<" prefix, which bash then interprets as a here-doc delimiter
// and reads stdin until EOF (corrupting the command). Catch any
// "<<TOKEN>" or "<<TOKEN<TOKEN>" shape where the inner content does NOT
// contain pipe (pipe is reserved for the explicit |...|> sentinel form
// above to keep the rules orthogonal).
const RE_SENTINEL_HEREDOC = /<<[^|>\s]{1,64}>/g;
// R1.x command-prefix sentinel (P6-2 2026-05-22): "<|find", "<|\find" etc.
// "<|" immediately followed by a non-whitespace/non-pipe/non-> char.
// Models emit this when the JSON serializer leaks a sentinel token before a
// command word but without the closing "|>" terminator.
const RE_SENTINEL_CMD_PREFIX = /<\|(?=[^\s|>])/g;

// R1.x' double-variant cmd-prefix sentinel (P2.24c-fix, 2026-05-22): "<<|find",
// "<<|\find" etc. Without this, RE_SENTINEL_CMD_PREFIX matches from index 1 of
// "<<|find" (consuming "<|f" → leaving "<find"). The double variant matches the
// leading "<<|" so the entire orphan prefix is stripped. Applied BEFORE the
// single variant so it always wins on this pattern.
const RE_SENTINEL_CMD_PREFIX_DOUBLE = /<<\|(?=[^\s|>])/g;

// R5b (P2.24c, 2026-05-22): unconditional orphan-prefix strip. Catches cases
// where the next byte after "<|" or "<<|" is a control character (e.g. \f from
// "\\f" JSON-decoded), which RE_SENTINEL_CMD_PREFIX's `[^\s|>]` lookahead
// rejects because `\s` includes \f/\v. Position-free, no lookahead.
// Safe ordering: runs AFTER all paired/open sentinel regexes, so legitimate
// `<|...|>` pairs are already consumed.
const RE_SENTINEL_PIPE_ORPHAN_DOUBLE = /<<\|/g;
const RE_SENTINEL_PIPE_ORPHAN_SINGLE = /<\|/g;

// R5d trailing-orphan (P2.24d, 2026-05-23): strip trailing "<|" / "<<|"
// sequences (+ surrounding whitespace) at end-of-string. Reproduction case:
// jsonl L98 — Gemma4 emitted write args.content ending in "\n<|" (sentinel
// open token leaked at final emission, no closing "|>"). R1 sentinel regexes
// require either a paired form or a non-empty suffix; trailing standalone
// "<|" matches none of them. R5b would have caught it but is gated to
// EXEC_CMD_SANITIZED_FIELDS only. Trailing-only is safer than global orphan
// strip because legitimate prose mid-content "<|" (rare but possible in
// markdown about tokens/syntax) is preserved. Applies to all sanitized
// fields including markdown content.
const RE_SENTINEL_TRAILING_ORPHAN = /(?:<<?\|+\s*)+$/;

// R5c (P2.24c, 2026-05-22): strip stray ASCII control bytes that Gemma4
// occasionally leaks alongside sentinel tokens (form-feed \x0c, vertical-tab
// \x0b, etc.). Preserves \t (\x09), \n (\x0a), \r (\x0d) which are
// legitimate in multi-line script bodies.
// eslint-disable-next-line no-control-regex
const RE_CONTROL_CHARS_SAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// R2 html-tag: matches "</tag>", "<tag>", "<tag attr=value ...>".
// Inner attr region bounded to 256 chars and may not contain "<" or ">".
const RE_HTML_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]{0,32})(?:\s[^<>]{0,256})?>/g;

// R3 unescaped double quote counter (ignore \" escapes).
const RE_UNESCAPED_DQUOTE = /(?<!\\)"/g;

export type SanitizeMutation = {
  field: string;
  rule: "sentinel" | "html-tag" | "balance-quote" | "path-quote-strip" | "truncate";
  beforeLen: number;
  afterLen: number;
  sample?: string;
};

export type SanitizeStringResult = {
  value: string;
  mutations: SanitizeMutation[];
};

export type SanitizeStringOptions = {
  /** When true, apply R4 path-quote-strip and bypass R3 balance-quote. */
  isPath?: boolean;
};

export function sanitizeString(
  input: string,
  field: string,
  cfg: ToolArgSanitizeConfig,
  options: SanitizeStringOptions = {},
): SanitizeStringResult {
  const mutations: SanitizeMutation[] = [];
  let current = input;

  if (cfg.removeSentinel) {
    const before = current;
    // R5c (P2.24c) FIRST: strip stray ASCII control bytes (form-feed \x0c,
    // vertical-tab \x0b, etc.) BEFORE the sentinel regexes run, so the
    // lookahead-based RE_SENTINEL_CMD_PREFIX can match patterns like
    // "<|<form-feed>find ..." (which previously slipped through because \s
    // includes \f/\v). Preserves \t / \n / \r.
    let chain = current.replace(RE_CONTROL_CHARS_SAFE, "");
    chain = chain
      .replace(RE_SENTINEL_DOUBLE, "")
      .replace(RE_SENTINEL_OPEN_DOUBLE, "")
      .replace(RE_SENTINEL_NESTED_DOUBLE, "")
      .replace(RE_SENTINEL_SINGLE, "")
      .replace(RE_SENTINEL_OPEN_SINGLE, "")
      .replace(RE_SENTINEL_NESTED_SINGLE, "")
      .replace(RE_SENTINEL_HEREDOC, "");
    // CMD_PREFIX variants strip orphan "<|" / "<<|" before command words.
    // Skipped on path fields so R4 path-quote-strip (below) handles them and
    // attributes the mutation to "path-quote-strip" rule (P2.19b contract).
    // DOUBLE applied first to ensure "<<|" matches as a unit (otherwise the
    // SINGLE pattern matches from index 1, leaving a stray "<").
    if (!options.isPath) {
      chain = chain.replace(RE_SENTINEL_CMD_PREFIX_DOUBLE, "").replace(RE_SENTINEL_CMD_PREFIX, "");
    }
    // R5b (P2.24c): exec/cmd/script fields get an unconditional orphan-prefix
    // strip pass as a last-resort net for any remaining "<|" / "<<|" tokens.
    // Safe because shell command syntax never legitimately contains them.
    // Also skipped on path fields (R4 handles).
    if (EXEC_CMD_SANITIZED_FIELDS.has(field) && !options.isPath) {
      chain = chain
        .replace(RE_SENTINEL_PIPE_ORPHAN_DOUBLE, "")
        .replace(RE_SENTINEL_PIPE_ORPHAN_SINGLE, "");
    }
    // R5d trailing-orphan (P2.24d): unconditional trailing "<|" strip for
    // all sanitized fields (including content/text/body/message). Safe
    // because mid-content "<|" is preserved; only end-of-string is touched.
    // Path fields skip (R4 path-quote-strip handles trailing prefix forms).
    if (!options.isPath) {
      chain = chain.replace(RE_SENTINEL_TRAILING_ORPHAN, "");
    }
    const next = chain;
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

  // R4 path-quote-strip (P2.19b): for path-style fields only.
  // Strips residual sentinel prefix variants ("<|", "<<|", leading "\\")
  // and outer paired or one-side quotes/dquotes left by P2.18.x sanitize.
  // Runs BEFORE R3 balance-quote so that a one-sided dquote at either end is
  // removed rather than balanced (which would corrupt the path).
  if (options.isPath) {
    const before = current;
    let next = before.trim();
    // Sentinel prefix residue strip loop (defensive: P2.18.x normally catches
    // closed sentinels; this handles open-end variants that escaped that pass).
    let prefixGuard = 8;
    while (prefixGuard-- > 0) {
      if (next.startsWith("<<|")) {
        next = next.slice(3).trimStart();
        continue;
      }
      if (next.startsWith("<|")) {
        next = next.slice(2).trimStart();
        continue;
      }
      if (next.startsWith("\\")) {
        next = next.slice(1).trimStart();
        continue;
      }
      break;
    }
    // Paired outer quotes (same kind on both ends): strip in pairs.
    let pairGuard = 4;
    while (
      pairGuard-- > 0 &&
      next.length >= 2 &&
      ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'")))
    ) {
      next = next.slice(1, -1).trim();
    }
    // Unbalanced one-side leading/trailing quote.
    if (next.startsWith('"') || next.startsWith("'")) {
      next = next.slice(1).trim();
    }
    if (next.endsWith('"') || next.endsWith("'")) {
      next = next.slice(0, -1).trim();
    }
    if (next !== before) {
      mutations.push({
        field,
        rule: "path-quote-strip",
        beforeLen: before.length,
        afterLen: next.length,
        sample: before.slice(0, 64),
      });
      current = next;
    }
  }

  // R3 balance-quote: bypass when field is a path (R4 already normalized).
  if (cfg.balanceQuote && !options.isPath) {
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
        RE_SENTINEL_DOUBLE.test(value) ||
        RE_SENTINEL_CMD_PREFIX.test(value) ||
        RE_SENTINEL_OPEN_DOUBLE.test(value) ||
        RE_SENTINEL_NESTED_DOUBLE.test(value) ||
        RE_SENTINEL_SINGLE.test(value) ||
        RE_SENTINEL_OPEN_SINGLE.test(value) ||
        RE_SENTINEL_NESTED_SINGLE.test(value) ||
        RE_SENTINEL_HEREDOC.test(value) ||
        RE_HTML_TAG.test(value);
      // Reset global regex state after .test().
      RE_SENTINEL_DOUBLE.lastIndex = 0;
      RE_SENTINEL_OPEN_DOUBLE.lastIndex = 0;
      RE_SENTINEL_NESTED_DOUBLE.lastIndex = 0;
      RE_SENTINEL_SINGLE.lastIndex = 0;
      RE_SENTINEL_OPEN_SINGLE.lastIndex = 0;
      RE_SENTINEL_NESTED_SINGLE.lastIndex = 0;
      RE_SENTINEL_HEREDOC.lastIndex = 0;
      RE_HTML_TAG.lastIndex = 0;
      if (!looksContaminated) {
        result[key] = value;
        continue;
      }
    }
    const isPath = PATH_SANITIZED_FIELDS.has(key);
    const sanitized = sanitizeString(value, key, cfg, { isPath });
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
