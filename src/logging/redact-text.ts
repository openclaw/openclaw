import { isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";
import { redactStructuredAuthHeaders } from "../../packages/acp-core/src/structured-auth-redaction.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { replacePatternBounded } from "./redact-bounded.js";
import type { RedactionEdit } from "./redact-edit-composition.js";
import type { RedactionCapture } from "./redact-json.js";
import { LINEAR_MATCHER_SOURCES } from "./redact-linear-matchers.js";
import {
  maskToken,
  maskSecretValue,
  splitSecretValueForMask,
  splitFormAwareCredentialValue,
} from "./redact-mask.js";
import {
  getSecretCaptureStart,
  selectSecretCapture,
  parseRedactPatternSource,
  readRedactMatch,
  redactPemBlock,
  replaceRedactPattern,
  rewriteOpenEndedRepeats,
  setRedactPatternPrefilter,
  type RedactMatch,
  type RedactPattern,
  type ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";
import {
  AWS_SECRET_ACCESS_KEY_MATCHER,
  createBackendRedactPatterns,
  DEFAULT_REDACT_PATTERNS,
  FORM_BODY_KEY_INVISIBLE_CHARS,
  IDENTIFIER_SAFE_TOKEN_BOUNDARY,
  VENDOR_TOKEN_REDACT_PATTERNS,
} from "./redact-patterns.js";
import { PEM_REDACT_MATCHER, PEM_REDACT_PATTERN_SOURCE } from "./redact-pem.js";
import { startRedactionMeasurement } from "./redact-performance.js";
import { couldMatchVendorRedactPatterns } from "./redact-prefilter.js";

const backendPatterns = createBackendRedactPatterns();
const shellReferencePreservingPatterns = new WeakSet<ResolvedRedactPattern>();
// Built-in resolved patterns scan whole text; only operator-configured regexes use the
// bounded chunked scan, whose cost on operator expressions is the measured safeguard.
const builtInResolvedPatterns = new WeakSet<ResolvedRedactPattern>();
const vendorResolvedPatterns = new WeakMap<ResolvedRedactPattern, () => boolean>();
const vendorSources = new Set(VENDOR_TOKEN_REDACT_PATTERNS);
// Patterns whose left-context assertions or complete token can cross a chunk boundary must run
// against the full string; chunking can invent a `^` boundary or split the secret itself.
const chunkUnsafePatterns = new WeakSet<ResolvedRedactPattern>();
// Canonical built-in sources are the only expressions the repeat rewriter optimizes; every
// operator-configured source compiles unmodified so its exact legacy language is preserved.
const canonicalBuiltInSources = new Set<string>(
  DEFAULT_REDACT_PATTERNS.filter((entry): entry is string => typeof entry === "string"),
);
const formAwareEqualsAssignmentPatterns = new WeakSet<ResolvedRedactPattern>();
let defaultResolvedPatterns: ResolvedRedactPattern[] | undefined;
let warnedInvalidPatterns = false;

const FORM_BODY_KEY_OBFUSCATION_RE = new RegExp(
  String.raw`[${FORM_BODY_KEY_INVISIBLE_CHARS}+]`,
  "gu",
);
const FORM_BODY_KEY_SEPARATOR_RE = /[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu;
const FORM_BODY_PERCENT_ESCAPE_RE = /%[0-9A-Fa-f]{2}/u;
const FORM_BODY_KEY = String.raw`[${FORM_BODY_KEY_INVISIBLE_CHARS}+]*(?:[A-Za-z_]|%[0-9A-Fa-f]{2})(?:[A-Za-z0-9_.-]|%[0-9A-Fa-f]{2}|[${FORM_BODY_KEY_INVISIBLE_CHARS}+])*`;
const FORM_BODY_VALUE = "[^&\\s<>]*";
const URL_QUERY_VALUE = "[^&#\\s<>]*";
const FORM_BODY_PAIR = String.raw`${FORM_BODY_KEY}=${FORM_BODY_VALUE}`;
const FORM_BODY_RE = new RegExp(String.raw`^${FORM_BODY_PAIR}(?:&${FORM_BODY_PAIR})+$`, "u");
const FORM_BODY_SUBSTRING_RE = new RegExp(
  String.raw`(^|[\s:({\[,="'` + "`" + String.raw`])(${FORM_BODY_PAIR}(?:&${FORM_BODY_PAIR})+)`,
  "gu",
);
const ENCODED_FORM_PAIR_RE = new RegExp(
  String.raw`(^|[\s:({\[,="'` + "`" + String.raw`&])(${FORM_BODY_KEY})=(${FORM_BODY_VALUE})`,
  "gu",
);
const FORM_BODY_CONTEXT_SINGLE_PAIR_RE = new RegExp(
  String.raw`(\b(?:body|form(?:[-_\s]?body)?)\s*[:=]\s*(["'\x60]?))(${FORM_BODY_KEY})=(${FORM_BODY_VALUE})(["'\x60]?)`,
  "giu",
);
const URL_QUERY_PAIR_RE = new RegExp(
  String.raw`([?&])(${FORM_BODY_KEY})=(${URL_QUERY_VALUE})`,
  "gu",
);
const FORM_BODY_LINE_BREAK_SPLIT_RE = /(\r\n|\r|\n)/u;
const FORM_BODY_LINE_BREAK_SEGMENT_RE = /^(?:\r\n|\r|\n)$/u;

function parsePattern(raw: RedactPattern): ResolvedRedactPattern | null {
  if (raw === PEM_REDACT_PATTERN_SOURCE) {
    return PEM_REDACT_MATCHER;
  }
  if (typeof raw !== "string" && !(raw instanceof RegExp)) {
    // Rejected config still reaches diagnostic redaction; only internal matchers have exec.
    return raw !== null && typeof raw === "object" && typeof raw.exec === "function" ? raw : null;
  }
  // Linear matchers and compiled regexes share the source's masking policies below.
  let pattern: ResolvedRedactPattern | null =
    typeof raw === "string" ? (LINEAR_MATCHER_SOURCES.get(raw) ?? null) : null;
  let canPrefilter = true;
  if (raw instanceof RegExp) {
    if (raw.flags.includes("g")) {
      pattern = raw;
    } else {
      pattern = new RegExp(raw.source, `${raw.flags}g`);
    }
  } else if (!pattern && raw.trim()) {
    const [source, flags] = parseRedactPatternSource(raw);
    // Open-ended repeats on canonical built-in flat single-character atoms compile without
    // one backtrack stack entry per repetition, so multi-megabyte values no longer overflow
    // the regex stack. Operator-configured sources compile unmodified: legacy escape and
    // class boundaries parse their atoms in ways the rewriter does not model, so rewriting
    // them could silently change the configured pattern's language.
    const optimized = canonicalBuiltInSources.has(raw)
      ? rewriteOpenEndedRepeats(source, flags)
      : source;
    pattern = compileConfigRegex(optimized, flags)?.regex ?? null;
    canPrefilter =
      pattern !== null &&
      pattern.source === optimized &&
      pattern.flags === flags &&
      pattern.exec === RegExp.prototype.exec &&
      pattern[Symbol.replace] === RegExp.prototype[Symbol.replace];
  }
  if (pattern && typeof raw === "string" && backendPatterns.shellReferencePreserving.has(raw)) {
    shellReferencePreservingPatterns.add(pattern);
  }
  if (pattern && typeof raw === "string" && backendPatterns.formAware.has(raw)) {
    formAwareEqualsAssignmentPatterns.add(pattern);
  }
  if (
    pattern &&
    typeof raw === "string" &&
    (raw.startsWith(IDENTIFIER_SAFE_TOKEN_BOUNDARY) || backendPatterns.chunkUnsafe.has(raw))
  ) {
    chunkUnsafePatterns.add(pattern);
  }
  if (pattern && typeof raw === "string") {
    if (canonicalBuiltInSources.has(raw)) {
      builtInResolvedPatterns.add(pattern);
    }
    if (canPrefilter && vendorSources.has(raw) && !vendorResolvedPatterns.has(pattern)) {
      const source = pattern.source;
      const exec = pattern.exec;
      const flags = pattern instanceof RegExp ? pattern.flags : undefined;
      const replace = pattern instanceof RegExp ? pattern[Symbol.replace] : undefined;
      vendorResolvedPatterns.set(
        pattern,
        () =>
          pattern.source === source &&
          pattern.exec === exec &&
          (!(pattern instanceof RegExp) ||
            (pattern.flags === flags && pattern[Symbol.replace] === replace)),
      );
    }
    const probe = backendPatterns.prefilters.get(raw);
    if (canPrefilter && probe) {
      setRedactPatternPrefilter(pattern, probe);
    }
  }
  return pattern;
}

export function resolvePatterns(value?: readonly RedactPattern[]): ResolvedRedactPattern[] {
  if (usesBuiltInRedactPatterns(value)) {
    defaultResolvedPatterns ??= DEFAULT_REDACT_PATTERNS.map(parsePattern).filter(
      (re): re is ResolvedRedactPattern => Boolean(re),
    );
    return defaultResolvedPatterns;
  }
  // Combined policies: operator patterns composed with the canonical default arrays. Rule
  // identity decides provenance, not array identity: each raw entry that is itself a canonical
  // built-in rule keeps whole-text scanning, while actual operator rules keep bounded scanning.
  // Mark the resolved instances at parse time; the shared compiler can reuse a regex instance.
  const combined = new Set<ResolvedRedactPattern>();
  let invalid = !Array.isArray(value);
  for (const raw of Array.isArray(value) ? value : []) {
    const resolved = parsePattern(raw);
    if (resolved) {
      combined.add(resolved);
    } else {
      invalid = true;
    }
  }
  if (invalid) {
    // A malformed policy must keep both usable operator rules and default protection.
    for (const pattern of resolvePatterns()) {
      combined.add(pattern);
    }
    if (!warnedInvalidPatterns) {
      warnedInvalidPatterns = true;
      try {
        console.warn(
          "[openclaw] Ignoring invalid logging.redactPatterns entries; keeping valid patterns and built-in redaction. Fix logging.redactPatterns in your config.",
        );
      } catch {
        // Console capture can re-enter redaction, and a failed warning must not stop masking.
      }
    }
  }
  combined.add(AWS_SECRET_ACCESS_KEY_MATCHER);
  return [...combined];
}

export function usesBuiltInRedactPatterns(value?: readonly RedactPattern[]): boolean {
  return (
    value === undefined ||
    value === DEFAULT_REDACT_PATTERNS ||
    (Array.isArray(value) && value.length === 0)
  );
}

function normalizeSensitiveKeyName(value: string): string {
  const stripped = value.replace(FORM_BODY_KEY_SEPARATOR_RE, "");
  try {
    return decodeURIComponent(stripped)
      .replace(FORM_BODY_KEY_SEPARATOR_RE, "")
      .toLowerCase()
      .replaceAll("-", "_");
  } catch {
    return stripped.toLowerCase().replaceAll("-", "_");
  }
}

function isSensitiveBodyKey(key: string): boolean {
  return (
    isSensitiveUrlQueryParamName(key) ||
    backendPatterns.bodySecretKeys.has(normalizeSensitiveKeyName(key))
  );
}

function hasEncodedOrInvisibleFormKey(key: string): boolean {
  return (
    FORM_BODY_PERCENT_ESCAPE_RE.test(key) || key.replace(FORM_BODY_KEY_OBFUSCATION_RE, "") !== key
  );
}

type SensitiveAssignmentKind = "form" | "url" | "encoded" | "context";

// Visit one grammar pass in source order. The sinks keep replacement and original-offset
// coverage separate; later text passes still detect assignments in the rewritten text.
function visitSensitiveAssignments(
  text: string,
  kind: SensitiveAssignmentKind,
  visit: (start: number, end: number, maskable: string) => void,
): void {
  if (!text || (kind === "url" && !text.includes("?"))) {
    return;
  }
  if (
    kind === "encoded" &&
    !text.includes("%") &&
    text.replace(FORM_BODY_KEY_OBFUSCATION_RE, "") === text
  ) {
    return;
  }
  if (kind === "context" && !/[=:]/u.test(text)) {
    return;
  }
  const visitPair = (key: string, token: string, valueOffset: number): void => {
    if (kind === "encoded" && !hasEncodedOrInvisibleFormKey(key)) {
      return;
    }
    if (!isSensitiveBodyKey(key)) {
      return;
    }
    const { maskable, maskStart, maskEnd } = splitSecretValueForMask(token);
    visit(valueOffset + maskStart, valueOffset + maskEnd, maskable);
  };
  if (kind === "form") {
    let cursor = 0;
    for (const pair of text.split("&")) {
      const equalsIndex = pair.indexOf("=");
      if (equalsIndex >= 0) {
        visitPair(
          pair.slice(0, equalsIndex),
          pair.slice(equalsIndex + 1),
          cursor + equalsIndex + 1,
        );
      }
      cursor += pair.length + 1;
    }
    return;
  }
  const pattern =
    kind === "url"
      ? URL_QUERY_PAIR_RE
      : kind === "encoded"
        ? ENCODED_FORM_PAIR_RE
        : FORM_BODY_CONTEXT_SINGLE_PAIR_RE;
  const keyIndex = kind === "context" ? 3 : 2;
  // These private synchronous sinks cannot re-enter the scanner. Release regex state on errors too.
  pattern.lastIndex = 0;
  try {
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const prefix = match[1] ?? "";
      const key = match[keyIndex] ?? "";
      visitPair(key, match[keyIndex + 1] ?? "", match.index + prefix.length + key.length + 1);
    }
  } finally {
    pattern.lastIndex = 0;
  }
}

export type PreparationEditSink = (edits: RedactionEdit[]) => void;

export function redactAssignmentValues(
  text: string,
  kind: SensitiveAssignmentKind,
  onEdits?: PreparationEditSink,
): string {
  const parts: string[] = [];
  const edits: RedactionEdit[] = [];
  let cursor = 0;
  visitSensitiveAssignments(text, kind, (start, end, maskable) => {
    const replacement = kind === "url" ? maskToken(maskable) : "***";
    parts.push(text.slice(cursor, start), replacement);
    if (onEdits) {
      edits.push({ start, end, replacement });
    }
    cursor = end;
  });
  if (edits.length > 0) {
    onEdits?.(edits);
  }
  return parts.length > 0 ? parts.join("") + text.slice(cursor) : text;
}

function redactFormBodyLine(text: string, onEdits?: PreparationEditSink): string {
  if (!text.includes("=")) {
    return text;
  }
  const contextRedacted = redactAssignmentValues(
    redactAssignmentValues(text, "encoded", onEdits),
    "context",
    onEdits,
  );
  if (!contextRedacted.includes("&")) {
    return contextRedacted;
  }
  if (FORM_BODY_RE.test(contextRedacted)) {
    return redactAssignmentValues(contextRedacted, "form", onEdits);
  }
  const substringEdits: RedactionEdit[] = [];
  const redacted = contextRedacted.replace(
    FORM_BODY_SUBSTRING_RE,
    (match, prefix: string, body: string, offset: number) => {
      const redactedBody = redactAssignmentValues(
        body,
        "form",
        onEdits
          ? (edits) => {
              for (const edit of edits) {
                substringEdits.push({
                  ...edit,
                  start: offset + prefix.length + edit.start,
                  end: offset + prefix.length + edit.end,
                });
              }
            }
          : undefined,
      );
      return redactedBody === body ? match : `${prefix}${redactedBody}`;
    },
  );
  if (substringEdits.length > 0) {
    onEdits?.(substringEdits);
  }
  return redactAssignmentValues(
    redactAssignmentValues(redacted, "encoded", onEdits),
    "context",
    onEdits,
  );
}

export function redactFormBody(text: string, onEdits?: PreparationEditSink): string {
  // Every form grammar requires a literal assignment separator, including encoded keys.
  if (!text.includes("=")) {
    return text;
  }
  if (FORM_BODY_LINE_BREAK_SPLIT_RE.test(text)) {
    let offset = 0;
    return text
      .split(FORM_BODY_LINE_BREAK_SPLIT_RE)
      .map((segment) => {
        const result = FORM_BODY_LINE_BREAK_SEGMENT_RE.test(segment)
          ? segment
          : redactFormBodyLine(
              segment,
              onEdits
                ? (edits) =>
                    onEdits(
                      edits.map((edit) => ({
                        ...edit,
                        start: offset + edit.start,
                        end: offset + edit.end,
                      })),
                    )
                : undefined,
            );
        offset += result.length;
        return result;
      })
      .join("");
  }
  return redactFormBodyLine(text, onEdits);
}

export function isShellReferenceToKey(key: string, value: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return false;
  }
  const bare = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (bare) {
    return bare[1] === key;
  }
  const braced = value.match(/^\$\{([A-Z_][A-Z0-9_]*)(?::[-=?+])?\}$/);
  return braced?.[1] === key;
}

function shouldPreserveShellReferenceMatch(match: string, token: string): boolean {
  const key = match.match(/\b([A-Z_][A-Z0-9_]*)\b\s*[=:]/)?.[1];
  return key ? isShellReferenceToKey(key, token) : false;
}

function isEmptyShellParameterExpansionTail(token: string): boolean {
  return /^[-=?+]\}$/.test(token);
}

export function prepareRedactionCapture(
  { match, groups, input, offset, replacement: policyReplacement }: RedactMatch,
  pattern: ResolvedRedactPattern,
): RedactionCapture | undefined {
  if (match.includes("PRIVATE KEY-----")) {
    return {
      start: offset,
      end: offset + match.length,
      value: match,
      redact: (target) => ({
        start: target.start,
        end: target.end,
        value: target.value,
        replacement: policyReplacement ?? redactPemBlock(target.value, "…redacted…"),
      }),
    };
  }
  const selected = selectSecretCapture(match, groups);
  if (selected.value === "***") {
    return undefined;
  }
  const tokenIndex =
    selected.value === match ? 0 : getSecretCaptureStart(pattern, input, match, offset, selected);
  if (tokenIndex < 0) {
    return undefined;
  }
  const start = offset + tokenIndex;
  return {
    start,
    end: start + selected.value.length,
    value: selected.value,
    redact: (target) => {
      const token = target.value;
      const formAwareValue = formAwareEqualsAssignmentPatterns.has(pattern)
        ? splitFormAwareCredentialValue(token)
        : { secret: token, suffix: "" };
      // An earlier pass (form-body or quoted-assignment masking) may already have replaced this
      // value with ***; re-masking would strip its quote wrapper around the placeholder.
      if (splitSecretValueForMask(formAwareValue.secret).maskable === "***") {
        return undefined;
      }
      const isShellReferencePattern = shellReferencePreservingPatterns.has(pattern);
      // Preserve shell variable references (e.g. `MY_TOKEN=$MY_TOKEN`) for assignment patterns
      // registered as shell-reference-preserving, so non-secret expansions that merely echo the
      // assignment key are not masked.
      if (
        isShellReferencePattern &&
        (shouldPreserveShellReferenceMatch(match, token) ||
          isEmptyShellParameterExpansionTail(token))
      ) {
        return undefined;
      }
      // Assignment values can legitimately include trailing shell/structural characters
      // (e.g. `${VAR:-default}`); mask the captured token whole so those characters count toward the
      // retained hint instead of being exposed by delimiter-aware masking.
      const masked =
        policyReplacement ??
        (isShellReferencePattern
          ? maskToken(token)
          : `${maskSecretValue(formAwareValue.secret, { hinted: true })}${formAwareValue.suffix}`);
      return { start: target.start, end: target.end, replacement: masked };
    },
  };
}

function redactMatch(match: RedactMatch, pattern: ResolvedRedactPattern): string {
  const capture = prepareRedactionCapture(match, pattern);
  const edit = capture?.redact(capture);
  return edit
    ? match.match.slice(0, edit.start - match.offset) +
        edit.replacement +
        match.match.slice(edit.end - match.offset)
    : match.match;
}

export function redactText(
  text: string,
  patterns: ResolvedRedactPattern[],
  options?: {
    fullContext?: boolean;
  },
): string {
  const finishMeasurement = startRedactionMeasurement("text");
  let outcome: "ok" | "error" = "error";
  try {
    let next = redactFormBody(
      redactAssignmentValues(redactStructuredAuthHeaders(text, "***"), "url"),
    );
    let pattern: ResolvedRedactPattern;
    const replace = (match: RedactMatch) => redactMatch(match, pattern);
    const replaceRegex = (...args: unknown[]) => replace(readRedactMatch(args));
    let vendorInput: string | undefined;
    let vendorMatch = false;
    // Built-in rules (linear matchers and regexes) scan whole text: chunking missed
    // credentials that straddled a boundary. Operator-configured regexes keep the bounded
    // chunked scan, whose cost on operator expressions is the measured safeguard.
    for (pattern of patterns) {
      if (vendorResolvedPatterns.get(pattern)?.()) {
        if (vendorInput !== next) {
          vendorInput = next;
          vendorMatch = couldMatchVendorRedactPatterns(next);
        }
        if (!vendorMatch) {
          if (pattern instanceof RegExp) {
            pattern.lastIndex = 0;
          }
          continue;
        }
      }
      next =
        pattern instanceof RegExp &&
        !options?.fullContext &&
        !builtInResolvedPatterns.has(pattern) &&
        !chunkUnsafePatterns.has(pattern)
          ? replacePatternBounded(next, pattern, replaceRegex)
          : replaceRedactPattern(next, pattern, replace, replaceRegex);
    }
    outcome = "ok";
    return next;
  } finally {
    finishMeasurement?.(outcome, text.length, patterns.length);
  }
}

export function getDefaultResolvedRedactPatterns(): ResolvedRedactPattern[] | undefined {
  return defaultResolvedPatterns;
}

export function isCredentialHeaderField(key: string): boolean {
  return backendPatterns.credentialHeaderField.test(key);
}
