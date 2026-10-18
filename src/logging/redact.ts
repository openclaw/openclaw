import { isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";
import {
  findStructuredAuthParamRanges,
  redactStructuredAuthHeaders,
} from "../../packages/acp-core/src/structured-auth-redaction.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { readLoggingConfig } from "./config.js";
import { getFileLogRedactionMessage } from "./logger-file-message.js";
import { replacePatternBounded } from "./redact-bounded.js";
import {
  applyRedactionEdits,
  composeRedactionEdits,
  type RedactionEdit,
} from "./redact-edit-composition.js";
import {
  redactJsonRecord,
  type RedactionMessage,
  type RedactionCapture,
  type RedactionField,
  type RedactionOrigins,
} from "./redact-json.js";
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
  AWS_SECRET_ACCESS_KEY_FIELD_KEYS,
  AWS_SECRET_ACCESS_KEY_MATCHER,
  createBackendRedactPatterns,
  DEFAULT_REDACT_PATTERNS,
  FORM_BODY_KEY_INVISIBLE_CHARS,
  IDENTIFIER_SAFE_TOKEN_BOUNDARY,
  PAYMENT_CREDENTIAL_ENV_KEYS,
  PAYMENT_CREDENTIAL_JSON_KEYS,
  PAYMENT_CREDENTIAL_QUERY_KEYS,
  VENDOR_TOKEN_REDACT_PATTERNS,
} from "./redact-patterns.js";
import { PEM_REDACT_MATCHER, PEM_REDACT_PATTERN_SOURCE } from "./redact-pem.js";
import { startRedactionMeasurement } from "./redact-performance.js";
import {
  couldMatchDefaultFullContextPatterns,
  couldMatchDefaultRedactPatterns,
  couldMatchVendorRedactPatterns,
  createRedactPrefilter,
} from "./redact-prefilter.js";
import { redactRegisteredSecretValues } from "./secret-redaction-registry.js";
import { shouldRedactStructuredAuthorizationCode } from "./structured-authorization-code.js";

type RedactSensitiveMode = "off" | "tools";
type LoggingConfig = OpenClawConfig["logging"];

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
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
// A nested URL carried inside a query value arrives percent-encoded, so its
// separators are `%3F`/`%26` and its `=` is `%3D`. None of the assignment
// grammars above match that, and net-policy's URL redactor -- which does decode
// nested URLs -- is not on this path, so a credential in a `redirect_uri=`
// callback reached the log in full. Stop the value at the next encoded
// separator; the lookahead is checked per character, so the scan stays linear.
const ENCODED_URL_QUERY_PAIR_RE = new RegExp(
  String.raw`(%3F|%26|[?&])((?:(?!%3D|%26)[A-Za-z0-9_.%~-]){1,128})%3D((?:(?!%26)[^&\s"'<>])*)`,
  "giu",
);
// Bound nested query scanning the way net-policy bounds nested decoding, so a
// hostile chain of nested callbacks cannot grow the work it costs to scan one value.
const MAX_NESTED_URL_QUERY_DEPTH = 8;
const URL_QUERY_PAIR = String.raw`([?&])(${FORM_BODY_KEY})=(${URL_QUERY_VALUE})`;
const URL_QUERY_PAIR_RE = new RegExp(URL_QUERY_PAIR, "gu");
const FORM_BODY_LINE_BREAK_SPLIT_RE = /(\r\n|\r|\n)/u;
const FORM_BODY_LINE_BREAK_SEGMENT_RE = /^(?:\r\n|\r|\n)$/u;
const STRUCTURED_SECRET_FIELD_RE = new RegExp(
  String.raw`^(?:api[-_]?key|apiKey|api[-_]?token|apiToken|bearer[-_]?token|bearerToken|token|secret|password|passwd|${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|credential|authorization|private[-_]?key|privateKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|secret[-_]?value|secretValue|raw[-_]?secret|rawSecret|secret[-_]?input|secretInput|key|key[-_]?material|keyMaterial|jwt|session|signature|cookie|set[-_]?cookie|${PAYMENT_CREDENTIAL_QUERY_KEYS}|${PAYMENT_CREDENTIAL_JSON_KEYS})$`,
  "i",
);
const STRUCTURED_INTERNAL_SOURCE_PATH_VALUE_RE = /^\$WORKSPACE_DIR\/[A-Za-z0-9._/-]+\.jsonl$/u;
const STRUCTURED_APP_PASSWORD_FIELD_RE =
  /^(?:apple|icloud|app[-_]?specific[-_]?password|appSpecificPassword|application[-_]?password|text|content|message|error|errorMessage|detail|details|reason)$/i;
const APP_SPECIFIC_PASSWORD_RE = /\b([a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4})\b/g;
const BENIGN_APP_PASSWORD_WORDS = new Set([
  "case",
  "claw",
  "demo",
  "file",
  "main",
  "name",
  "open",
  "path",
  "slug",
  "test",
]);
const STRUCTURED_SECRET_ENV_FIELD_RE = new RegExp(
  String.raw`^(?:(?:[A-Z0-9]+[_-])+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})$`,
  "i",
);

type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: readonly RedactPattern[];
};

type ResolvedRedactOptions = {
  mode: RedactSensitiveMode;
  patterns: ResolvedRedactPattern[];
};

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

function resolvePatterns(value?: readonly RedactPattern[]): ResolvedRedactPattern[] {
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

function usesBuiltInRedactPatterns(value?: readonly RedactPattern[]): boolean {
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
  const visitPair = (key: string, token: string, valueOffset: number, depth = 0): void => {
    if (kind === "encoded" && !hasEncodedOrInvisibleFormKey(key)) {
      return;
    }
    if (!isSensitiveBodyKey(key)) {
      // A nested URL carried in a query value (`?cb=https://in/?token=...`) is one
      // value whose own name is not a credential, so the credential in its query was
      // never classified. Only `?` can open an assignment inside a value; `&` cannot
      // appear in one. A sensitive value is still masked whole below, so scanning
      // only non-sensitive values keeps this additive -- nothing masked before stops
      // being masked. A fresh regex per level keeps `lastIndex` out of the recursion.
      if (kind !== "url" || depth >= MAX_NESTED_URL_QUERY_DEPTH || !token.includes("?")) {
        return;
      }
      const nested = new RegExp(URL_QUERY_PAIR, "gu");
      for (let match = nested.exec(token); match; match = nested.exec(token)) {
        const nestedPrefix = match[1] ?? "";
        const nestedKey = match[2] ?? "";
        visitPair(
          nestedKey,
          match[3] ?? "",
          valueOffset + match.index + nestedPrefix.length + nestedKey.length + 1,
          depth + 1,
        );
      }
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

type PreparationEditSink = (edits: RedactionEdit[]) => void;

function redactAssignmentValues(
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

function redactFormBody(text: string, onEdits?: PreparationEditSink): string {
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

function isShellReferenceToKey(key: string, value: string): boolean {
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

function maskSecretFieldValue(key: string, value: string): string {
  const expansion = value.match(/^\$\{([A-Z_][A-Z0-9_]*):[-=?+][^{}]+\}(?![\s\S])/);
  if (expansion && expansion[1] === key) {
    return `${value.slice(0, value.indexOf(":") + 2)}***}`;
  }
  return "***";
}

function shouldPreserveShellReferenceMatch(match: string, token: string): boolean {
  const key = match.match(/\b([A-Z_][A-Z0-9_]*)\b\s*[=:]/)?.[1];
  return key ? isShellReferenceToKey(key, token) : false;
}

function isEmptyShellParameterExpansionTail(token: string): boolean {
  return /^[-=?+]\}$/.test(token);
}

function prepareRedactionCapture(
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
          : `${maskSecretValue(formAwareValue.secret)}${formAwareValue.suffix}`);
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

function looksLikeAppSpecificPassword(candidate: string): boolean {
  return candidate.split("-").every((part) => !BENIGN_APP_PASSWORD_WORDS.has(part.toLowerCase()));
}

function redactAppSpecificPasswords(text: string): string {
  if (!text.includes("-")) {
    return text;
  }
  return text.replace(APP_SPECIFIC_PASSWORD_RE, (match: string, token: string) =>
    looksLikeAppSpecificPassword(token) ? maskToken(token) : match,
  );
}

function resolveConfigRedaction(): RedactOptions {
  const cfg = readLoggingConfig();
  return {
    mode: DEFAULT_REDACT_MODE,
    patterns: cfg?.redactPatterns,
  };
}

export function resolveRedactOptions(options?: RedactOptions): ResolvedRedactOptions {
  const resolved = options ?? resolveConfigRedaction();
  const mode = resolved.mode === "off" ? "off" : DEFAULT_REDACT_MODE;
  return { mode, patterns: mode === "off" ? [] : resolvePatterns(resolved.patterns) };
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const exactRedacted = redactRegisteredSecretValues(text, maskToken);
  return redactSensitiveTextWithOptions(exactRedacted, options ?? resolveConfigRedaction());
}

function redactSensitiveTextWithOptions(
  exactRedacted: string,
  resolvedOptions: RedactOptions,
): string {
  if (resolvedOptions.mode === "off") {
    return exactRedacted;
  }
  if (
    usesBuiltInRedactPatterns(resolvedOptions.patterns) &&
    !couldMatchDefaultRedactPatterns(exactRedacted)
  ) {
    return exactRedacted;
  }
  const resolved = resolveRedactOptions(resolvedOptions);
  return redactText(exactRedacted, resolved.patterns);
}

export function redactToolDetail(detail: string): string {
  return redactToolPayloadText(detail);
}

function resolveToolPayloadRedaction(
  loggingConfig: LoggingConfig | undefined = readLoggingConfig(),
): RedactOptions {
  const userPatterns = loggingConfig?.redactPatterns;
  const patterns =
    Array.isArray(userPatterns) && userPatterns.length > 0
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : userPatterns;
  return { mode: "tools", patterns };
}

// Forces the default diagnostic policy and adds operator patterns without allowing
// logging.redactSensitive="off" to expose credentials in support output.
export function redactToolPayloadText(text: string): string {
  return redactToolPayloadTextWithConfig(text, readLoggingConfig());
}

export function redactToolPayloadTextWithConfig(
  text: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactSensitiveText(text, resolveToolPayloadRedaction(loggingConfig));
}

export function isSensitiveFieldKey(key: string): boolean {
  return STRUCTURED_SECRET_FIELD_RE.test(key) || STRUCTURED_SECRET_ENV_FIELD_RE.test(key);
}

function isPublicShareIdPath(path: readonly string[]): boolean {
  if (path.at(-1)?.toLowerCase() !== "id") {
    return false;
  }
  const parentKey = path.at(-2)?.toLowerCase().replaceAll("-", "").replaceAll("_", "");
  return parentKey === "publicshare";
}

function redactSensitiveFieldValueWithOptions(
  key: string,
  value: string,
  options: RedactOptions,
  path: readonly string[] = [key],
  objectPath = true,
  couldMatch = couldMatchDefaultRedactPatterns,
): string {
  const exactRedacted = redactRegisteredSecretValues(value, maskToken);
  if (isPublicShareIdPath(path)) {
    return maskToken(exactRedacted);
  }
  const resolved = resolveRedactOptions(options);
  if (resolved.mode === "off") {
    return exactRedacted;
  }
  // Structured payloads can contain thousands of short, benign strings. Avoid
  // walking the full default pattern table for each one; the prefilter is kept
  // in sync with every built-in pattern and sensitive form/URL key. Explicit
  // user patterns still require the full scan because they have no prefilter.
  const redacted =
    !usesBuiltInRedactPatterns(options.patterns) || couldMatch(exactRedacted)
      ? redactText(exactRedacted, resolved.patterns)
      : exactRedacted;
  const shouldRedactAppPassword = redacted !== value || STRUCTURED_APP_PASSWORD_FIELD_RE.test(key);
  if (shouldRedactAppPassword) {
    const appRedacted = redactAppSpecificPasswords(redacted);
    if (appRedacted !== value) {
      return appRedacted;
    }
  }
  if (redacted !== value) {
    return redacted;
  }
  return shouldRedactStructuredStringField(key, exactRedacted, path, objectPath)
    ? maskToken(exactRedacted)
    : exactRedacted;
}

export function redactSensitiveFieldValue(
  key: string,
  value: string,
  options?: RedactOptions,
): string {
  return redactSensitiveFieldValueWithOptions(key, value, options ?? resolveToolPayloadRedaction());
}

function shouldRedactStructuredPrimitiveField(key: string, path: readonly string[]): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    isPublicShareIdPath(path) ||
    shouldRedactStructuredAuthorizationCode(normalizedKey, path) ||
    isSensitiveFieldKey(key)
  );
}

function isPlainRedactableObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactStructuredSecretValue(
  key: string,
  value: unknown,
  seen: WeakSet<object>,
  options: RedactOptions,
  couldMatch: (text: string) => boolean,
  path: readonly string[] = key ? [key] : [],
  objectPath = true,
): unknown {
  if (typeof value === "string") {
    return redactSensitiveFieldValueWithOptions(key, value, options, path, objectPath, couldMatch);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return shouldRedactStructuredPrimitiveField(key, path) ? "***" : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out = value.map((entry) =>
      redactStructuredSecretValue(key, entry, seen, options, couldMatch, path, false),
    );
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (!isPlainRedactableObject(value)) {
      return value;
    }
    seen.add(value);
    const entries = Object.entries(value);
    for (const entry of entries) {
      const [name, child] = entry;
      entry[1] = redactStructuredSecretValue(
        name,
        child,
        seen,
        options,
        couldMatch,
        [...path, name],
        objectPath,
      );
    }
    seen.delete(value);
    // Define own data properties so JSON field names cannot change the output prototype.
    return Object.fromEntries(entries);
  }
  return value;
}

function redactSecretsWithOptions<T>(value: T, options: RedactOptions): T {
  if (typeof value === "string") {
    return redactSensitiveText(value, options) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return redactStructuredSecretValue(
    "",
    value,
    new WeakSet<object>(),
    options,
    createRedactPrefilter(couldMatchDefaultRedactPatterns),
  ) as T;
}

export function redactSecrets<T>(value: T): T {
  return redactSecretsWithOptions(value, resolveToolPayloadRedaction());
}

function preservesStructuredReference(key: string, value: string): boolean {
  return (
    (key.toLowerCase() === "session" && STRUCTURED_INTERNAL_SOURCE_PATH_VALUE_RE.test(value)) ||
    isShellReferenceToKey(key, value)
  );
}

function shouldRedactStructuredStringField(
  key: string,
  value: string,
  path: readonly string[],
  objectPath: boolean,
): boolean {
  return (
    shouldRedactStructuredAuthorizationCode(
      key.toLowerCase(),
      path,
      objectPath ? value : undefined,
    ) ||
    (isSensitiveFieldKey(key) && !preservesStructuredReference(key, value))
  );
}

function classifyLogFieldProtection(
  key: string,
  path: readonly string[],
  objectPath: boolean,
  value: string | undefined,
): "legacy" | "header" | undefined {
  const legacy =
    value === undefined
      ? shouldRedactStructuredPrimitiveField(key, path)
      : isPublicShareIdPath(path) ||
        shouldRedactStructuredStringField(key, value, path, objectPath);
  return legacy ? "legacy" : backendPatterns.credentialHeaderField.test(key) ? "header" : undefined;
}

function getFieldRecordEdits(field: RedactionField, mode: RedactSensitiveMode): RedactionEdit[] {
  const { key, value, path, objectPath } = field;
  if (
    mode === "off" ||
    (!field.string && value === "null") ||
    !classifyLogFieldProtection(key, path, objectPath, field.string ? value : undefined)
  ) {
    return [];
  }
  return [{ start: 0, end: value.length, replacement: maskSecretFieldValue(key, value) }];
}

function getTextRecordEdits(
  field: RedactionField,
  mode: RedactSensitiveMode,
  fileFields: boolean,
): RedactionEdit[] {
  const { value } = field;
  if (field.isKey || (fileFields && !field.origin.structured)) {
    return [];
  }
  if (fileFields && field.origin.primitiveMask) {
    return [{ start: 0, end: value.length, replacement: "***" }];
  }
  if (!field.string) {
    return [];
  }
  const edits: RedactionEdit[] = [];
  const registered = redactRegisteredSecretValues(value, (secret, start) => {
    const replacement = maskToken(secret);
    edits.push({
      start,
      end: start + secret.length,
      replacement,
    });
    return replacement;
  });
  if (fileFields && isPublicShareIdPath(field.path)) {
    return [{ start: 0, end: value.length, replacement: maskToken(registered) }];
  }
  if (mode === "off") {
    return edits;
  }
  let combined = edits;
  const receive: PreparationEditSink = (added) => {
    combined = composeRedactionEdits(value.length, combined, added);
  };
  const headers = findStructuredAuthParamRanges(registered).map(({ start, end }) => ({
    start,
    end,
    replacement: "***",
  }));
  receive(headers);
  const url = redactAssignmentValues(applyRedactionEdits(registered, headers), "url", receive);
  redactFormBody(url, receive);
  return combined;
}

function getLegacyFieldRecordEdits(field: RedactionField, value: string): RedactionEdit[] {
  const { key, value: original, path, objectPath } = field;
  if (field.isKey || !field.origin.structured || !field.string) {
    return [];
  }
  if (isPublicShareIdPath(path)) {
    return [];
  }
  const edits: RedactionEdit[] = [];
  if (value !== original || STRUCTURED_APP_PASSWORD_FIELD_RE.test(key)) {
    for (const match of value.matchAll(APP_SPECIFIC_PASSWORD_RE)) {
      if (looksLikeAppSpecificPassword(match[0])) {
        edits.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: maskToken(match[0]),
        });
      }
    }
  }
  if (edits.length > 0 || value !== original) {
    return edits;
  }
  const protection = classifyLogFieldProtection(key, path, objectPath, value);
  return protection === "legacy"
    ? [{ start: 0, end: value.length, replacement: maskToken(value) }]
    : [];
}

export function resolveLogTailRedactOptions(): ResolvedRedactOptions {
  return resolveRedactOptions(resolveToolPayloadRedaction());
}

function* redactionEditMatches(input: string, edits: RedactionEdit[]): Iterable<RedactMatch> {
  for (const edit of edits) {
    yield {
      match: input.slice(edit.start, edit.end),
      groups: [],
      input,
      offset: edit.start,
      replacement: edit.replacement,
    };
  }
}

const preparationPatterns: ResolvedRedactPattern[] = [
  {
    source: "registered secret values",
    *exec(input) {
      const matches: RedactMatch[] = [];
      redactRegisteredSecretValues(input, (secret, offset) => {
        matches.push({ match: secret, groups: [], input, offset, replacement: maskToken(secret) });
        return secret;
      });
      yield* matches;
    },
  },
  {
    source: "structured authorization parameters",
    *exec(input) {
      for (const { start, end } of findStructuredAuthParamRanges(input)) {
        yield {
          match: input.slice(start, end),
          groups: [],
          input,
          offset: start,
          replacement: "***",
        };
      }
    },
  },
  {
    source: "URL query assignments",
    *exec(input) {
      const edits: RedactionEdit[] = [];
      redactAssignmentValues(input, "url", (added) => edits.push(...added));
      yield* redactionEditMatches(input, edits);
    },
  },
  {
    source: "encoded URL query assignments",
    *exec(input) {
      if (!/%3d/iu.test(input)) {
        return;
      }
      // Private synchronous sink; release the regex state on errors too.
      ENCODED_URL_QUERY_PAIR_RE.lastIndex = 0;
      try {
        for (
          let match = ENCODED_URL_QUERY_PAIR_RE.exec(input);
          match;
          match = ENCODED_URL_QUERY_PAIR_RE.exec(input)
        ) {
          const prefix = match[1] ?? "";
          const name = match[2] ?? "";
          const value = match[3] ?? "";
          if (!value || !isSensitiveBodyKey(name)) {
            continue;
          }
          // `%3D` is three characters; the value starts after it.
          const offset = match.index + prefix.length + name.length + 3;
          yield {
            match: value,
            groups: [],
            input,
            offset,
            replacement: "***",
          };
        }
      } finally {
        ENCODED_URL_QUERY_PAIR_RE.lastIndex = 0;
      }
    },
  },
  {
    source: "form bodies",
    *exec(input) {
      let edits: RedactionEdit[] = [];
      redactFormBody(input, (added) => {
        edits = composeRedactionEdits(input.length, edits, added);
      });
      yield* redactionEditMatches(input, edits);
    },
  },
];
const CONSOLE_STRUCTURAL_FIELDS = new Set(["time", "level"]);

/** Converts native values once and applies configured and structural protection before output. */
export function redactLogRecordForTransport(
  record: Record<string, unknown>,
  tail?: { redaction: ResolvedRedactOptions; message?: RedactionMessage },
): Record<string, unknown> {
  const finishMeasurement = startRedactionMeasurement("log-record");
  let outcome: "ok" | "error" = "error";
  let inputChars: number | undefined;
  try {
    const resolved = tail?.redaction ?? resolveRedactOptions();
    const ordinary = { structured: true, primitiveMask: false };
    const origins: RedactionOrigins = { value: ordinary, children: new Map() };
    const ancestors: {
      value: object;
      path: string[];
      key: string;
      origins: RedactionOrigins;
      structured: boolean;
    }[] = [];
    const json = JSON.stringify(record, function (this: object, key, value: unknown) {
      while (ancestors.length > 0 && ancestors.at(-1)?.value !== this) {
        ancestors.pop();
      }
      const parent = ancestors.at(-1);
      const array = Array.isArray(this);
      const fieldKey = array && parent ? parent.key : key;
      const path = array && parent ? parent.path : parent ? [...parent.path, key] : [];
      const source = value;
      const structured =
        (parent?.structured ?? true) &&
        (source === null ||
          typeof source !== "object" ||
          Array.isArray(source) ||
          isPlainRedactableObject(source));
      const primitiveMask =
        structured &&
        ["number", "boolean", "bigint"].includes(typeof source) &&
        classifyLogFieldProtection(fieldKey, path, !array, undefined) === "legacy";
      const circular =
        value !== null &&
        typeof value === "object" &&
        ancestors.some((frame) => frame.value === value);
      const emitted = circular ? "[Circular]" : typeof value === "bigint" ? String(value) : value;
      const container = emitted !== null && typeof emitted === "object";
      let node = origins;
      if (parent && parent.structured && (container || !structured || primitiveMask || circular)) {
        node = {
          value: { structured: structured && !circular, primitiveMask },
          children: new Map(),
        };
        parent.origins.children.set(key, node);
      } else if (parent) {
        node = parent.origins;
      } else {
        origins.value = { structured, primitiveMask };
      }
      if (container) {
        ancestors.push({ value: emitted, path, key: fieldKey, origins: node, structured });
      }
      return emitted;
    });
    inputChars = json.length;
    const couldMatch = createRedactPrefilter(couldMatchDefaultFullContextPatterns);
    const result = JSON.parse(
      redactJsonRecord(
        json,
        origins,
        [
          [{ patterns: resolved.patterns }],
          [
            { patterns: preparationPatterns },
            {
              patterns: resolved.patterns,
              ...(resolved.patterns === defaultResolvedPatterns ? { couldMatch } : {}),
            },
          ],
        ],
        prepareRedactionCapture,
        tail ? getLegacyFieldRecordEdits : () => [],
        (field) => getFieldRecordEdits(field, resolved.mode),
        (field) => getTextRecordEdits(field, resolved.mode, tail !== undefined),
        (field, currentValue) =>
          (field.path.length === 1 && CONSOLE_STRUCTURAL_FIELDS.has(field.key)) ||
          (resolved.patterns === defaultResolvedPatterns && !couldMatch(currentValue)),
        tail?.message,
      ),
    );
    outcome = "ok";
    return result;
  } finally {
    finishMeasurement?.(outcome, inputChars);
  }
}

/** The full default policy, programmatic matchers included; keep only the strings for `logging.redactPatterns`. */
export function getDefaultRedactPatterns(): RedactPattern[] {
  return [...DEFAULT_REDACT_PATTERNS];
}

// Match the complete batch, preserving JSON syntax through the transport's scalar editor.
export function redactSensitiveLines(
  lines: string[],
  resolved: ResolvedRedactOptions,
  selectedLines?: readonly boolean[],
): string[] {
  if (lines.length === 0 || resolved.mode === "off") {
    return selectedLines ? lines.filter((_, index) => selectedLines[index]) : lines;
  }
  // Partial PEM context belongs to the complete batch, not each JSON record.
  const recordPatterns = resolved.patterns.map((pattern) =>
    pattern.source === PEM_REDACT_PATTERN_SOURCE ? PEM_REDACT_MATCHER : pattern,
  );
  const recordRedaction = {
    ...resolved,
    // Tail context copies the pattern array; restore default-policy identity so
    // benign fields retain the transport redactor's built-in prefilter.
    patterns:
      defaultResolvedPatterns?.length === recordPatterns.length &&
      recordPatterns.every((pattern, index) => pattern === defaultResolvedPatterns?.[index])
        ? defaultResolvedPatterns
        : recordPatterns,
  };
  return redactJsonRecord(
    lines
      .map((line) => {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          return line;
        }
        if (record === null || typeof record !== "object" || !isPlainRedactableObject(record)) {
          return line;
        }
        const redacted = JSON.stringify(
          redactLogRecordForTransport(record, {
            redaction: recordRedaction,
            message: getFileLogRedactionMessage(record),
          }),
        );
        return redacted === JSON.stringify(record) ? line : redacted;
      })
      .join("\n"),
    { value: { structured: false, primitiveMask: false }, children: new Map() },
    [[], [{ patterns: [...preparationPatterns, ...resolved.patterns] }]],
    prepareRedactionCapture,
    () => [],
    () => [],
    () => [],
    () => true,
    undefined,
    { preserveLines: selectedLines !== undefined },
  )
    .split("\n")
    .filter((_, index) => selectedLines === undefined || selectedLines[index]);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
