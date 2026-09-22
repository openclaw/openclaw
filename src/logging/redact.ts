import { isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";
// Redaction helpers scrub secrets and sensitive identifiers from log output.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  findStructuredAuthParamRanges,
  redactStructuredAuthHeaders,
} from "../../packages/acp-core/src/structured-auth-redaction.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { readLoggingConfig } from "./config.js";
import { replacePatternBounded } from "./redact-bounded.js";
import {
  applyRedactionEdits,
  composeRedactionEdits,
  type RedactionEdit,
} from "./redact-edit-composition.js";
import { modelVisibleToolTextRedactionState } from "./redact-internal-state.js";
import { isFullContextToolPayloadRedaction } from "./redact-internal.js";
import {
  redactJsonRecord,
  getPatternRedactionEdits,
  type RedactionMessage,
  type RedactionTarget,
  type RedactionField,
  type RedactionOrigins,
} from "./redact-json.js";
import {
  iterateRedactMatches,
  parseRedactPatternSource,
  readRedactMatch,
  redactPemBlock,
  replaceRedactPattern,
  type RedactMatch,
  type RedactPattern,
  type ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";
import {
  AWS_SECRET_ACCESS_KEY_FIELD_KEYS,
  AWS_SECRET_ACCESS_KEY_MATCHER,
  BASE64_SAFE_TOKEN_BOUNDARY,
  BODY_SECRET_KEYS,
  CHUNK_UNSAFE_PATTERN_SOURCES,
  CREDENTIAL_HEADER_FIELD_RE,
  DEFAULT_REDACT_PATTERNS,
  DEFAULT_REDACT_STRING_PATTERNS,
  FORM_AWARE_EQUALS_ASSIGNMENT_PATTERN_SOURCES,
  FORM_BODY_KEY_INVISIBLE_CHARS,
  IDENTIFIER_SAFE_TOKEN_BOUNDARY,
  PAYMENT_CREDENTIAL_ENV_KEYS,
  PAYMENT_CREDENTIAL_JSON_KEYS,
  PAYMENT_CREDENTIAL_QUERY_KEYS,
  SHELL_REFERENCE_PRESERVING_PATTERN_SOURCES,
  TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS,
  TOOL_PAYLOAD_REDACT_PATTERNS,
} from "./redact-patterns.js";
import { PEM_REDACT_MATCHER, PEM_REDACT_PATTERN_SOURCE } from "./redact-pem.js";
import { startRedactionMeasurement } from "./redact-performance.js";
import {
  captureSecretRedactionRegistrySnapshot,
  createSecretValueRedactor,
  redactRegisteredSecretValues,
} from "./secret-redaction-registry.js";
import { shouldRedactStructuredAuthorizationCode } from "./structured-authorization-code.js";

type RedactSensitiveMode = "off" | "tools";
type LoggingConfig = OpenClawConfig["logging"];

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const shellReferencePreservingPatterns = new WeakSet<ResolvedRedactPattern>();
// Patterns whose left-context assertions or complete token can cross a chunk boundary must run
// against the full string; chunking can invent a `^` boundary or split the secret itself.
const chunkUnsafePatterns = new WeakSet<ResolvedRedactPattern>();
const formAwareEqualsAssignmentPatterns = new WeakSet<ResolvedRedactPattern>();
const sourceAssignmentPatterns = new WeakSet<ResolvedRedactPattern>();
let defaultResolvedPatterns: ResolvedRedactPattern[] | undefined;
let toolPayloadResolvedPatterns: ResolvedRedactPattern[] | undefined;

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
const SECRET_VALUE_TRAILING_DELIMITER_RE = /(["'`,;)}\]]+)$/u;
const SECRET_VALUE_SUFFIX_RE = /^["'`,;)}\]]*$/u;
const SECRET_VALUE_QUOTE_CHARS = new Set(['"', "'", "`"]);
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

// Fast-path gate: with no user-configured patterns, redactSensitiveText skips the full
// default-pattern walk unless one of these triggers matches. Every DEFAULT_REDACT_PATTERNS
// entry and sensitive form/URL key must stay reachable here — a missing trigger silently
// leaks that secret shape, so each family keeps a default-options fixture in redact.test.ts.
const DEFAULT_REDACT_PREFILTER_SOURCES: string[] = [
  // Sensitive key names shared by the env/JSON/query/form/header/assignment families.
  String.raw`KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|SIGNATURE|CREDENTIAL|CARD|CVC|CVV|PAYMENT|PRIVATE KEY`,
  String.raw`security[-_]?code|\bpass\s*[=:]|\bpassphrase\s*[=:]|_(?:password|pass|passphrase|passwd)\s*[=:]|jwt\s*[=:]|session=|code=|\bsig\s*=`,
  String.raw`\bBearer\s+`,
  // URL userinfo and connection-string password slots (`scheme://user:pass@host`).
  String.raw`:\/\/[^\/\s:@]*:[^\s@]+@`,
  // Vendor token prefixes and webhook hosts, ordered like DEFAULT_REDACT_PATTERNS.
  String.raw`sk-|gh[opsur]_|github_pat_|glpat-|gloas-|gldt-|glcbt-|glptt-|glft-|glimt-|glagent-|glwt-|glsoat-|glffct-|glrt-|glrtr-|GR1348941|_gitlab_session=|xox[baprs]-|xapp-|hooks\.slack\.com|discord|gsk_|AIza|ya29\.|1\/\/0|eyJ|pplx-|fal_|fc-|bb_live_|gAAAA|[sr]k_(?:live|test)_|SG\.|npm_|pypi-|do[opr]_v1_|dp\.(?:ct|pt|sa|st|scim|audit)\.|dckr_|bkua_|CCIPAT_|sbp_|dapi[0-9a-f]|dd[pw]_|glsa_|nfp_|CFPAT-|ATCTT3|ATATT|ATBB|BBDC-|HRKU-|pat-(?:eu|na)1-|apify_api_|FlyV1|fio-u-|tvly-|exa_|syt_|retaindb_|mem0_|brv_|xai-|fw-|fw_|fpk_`,
  String.raw`(?:^|[^A-Za-z0-9_])(?:am_|sk_)`,
  String.raw`A[KS]IA[A-Z0-9]|AKID|LTAI|hf_|api_org_|r8_`,
  String.raw`\bbot\d{6,}:|\b\d{6,}:[A-Za-z0-9_-]{20,}`,
  // Obfuscated form/URL keys: percent escapes can rewrite any key letter, while plus or
  // invisible splices break the literal key-name triggers above mid-word. After a splice the
  // tail may mix further splices with key characters (e.g. an interior plus a trailing
  // filler). Require a key character before or after a splice so bare `+=` or line-leading
  // `===` separators do not trip the fast path.
  String.raw`%[0-9A-Fa-f]{2}[${FORM_BODY_KEY_INVISIBLE_CHARS}+A-Za-z0-9_%.-]*=`,
  // Search at the required assignment separator, not at every invisible character.
  // Look behind it to retain the same obfuscated-key language without rescanning blank runs.
  String.raw`=(?<=(?:\+|[${FORM_BODY_KEY_INVISIBLE_CHARS}])(?:[${FORM_BODY_KEY_INVISIBLE_CHARS}+]*[A-Za-z0-9_%.-])+[${FORM_BODY_KEY_INVISIBLE_CHARS}+]*=)|=(?<=[A-Za-z0-9_%.-][${FORM_BODY_KEY_INVISIBLE_CHARS}+]+=)`,
];
const DEFAULT_REDACT_PREFILTER_RE = new RegExp(
  `(?:${DEFAULT_REDACT_PREFILTER_SOURCES.join("|")})`,
  "iu",
);

// Whole-context rules admit prefixes whose boundaries differ under Unicode case folding.
// Keep the shared text probe unchanged: its chunked matching has separate boundary semantics.
const FULL_CONTEXT_REDACT_EXTRA_TRIGGERS_RE =
  /JWT|Bearer\s+|am_|sk_|(?<!\d)\d{6,}:[A-Za-z0-9_-]{20,}/i;

type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: readonly RedactPattern[];
  sensitiveFieldPatterns?: readonly RedactPattern[];
};

type ResolvedRedactOptions = {
  mode: RedactSensitiveMode;
  patterns: ResolvedRedactPattern[];
};

function normalizeMode(value?: string): RedactSensitiveMode {
  return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: RedactPattern): ResolvedRedactPattern | null {
  if (raw === PEM_REDACT_PATTERN_SOURCE) {
    return PEM_REDACT_MATCHER;
  }
  if (typeof raw !== "string" && !(raw instanceof RegExp)) {
    return raw;
  }
  let pattern: RegExp | null = null;
  if (raw instanceof RegExp) {
    if (raw.flags.includes("g")) {
      pattern = raw;
    } else {
      pattern = new RegExp(raw.source, `${raw.flags}g`);
    }
  } else if (raw.trim()) {
    pattern = compileConfigRegex(...parseRedactPatternSource(raw))?.regex ?? null;
  }
  if (pattern && typeof raw === "string" && SHELL_REFERENCE_PRESERVING_PATTERN_SOURCES.has(raw)) {
    shellReferencePreservingPatterns.add(pattern);
  }
  if (pattern && typeof raw === "string" && TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS.has(raw)) {
    sourceAssignmentPatterns.add(pattern);
  }
  if (pattern && typeof raw === "string" && FORM_AWARE_EQUALS_ASSIGNMENT_PATTERN_SOURCES.has(raw)) {
    formAwareEqualsAssignmentPatterns.add(pattern);
  }
  if (
    pattern &&
    typeof raw === "string" &&
    (raw.startsWith(BASE64_SAFE_TOKEN_BOUNDARY) ||
      raw.startsWith(IDENTIFIER_SAFE_TOKEN_BOUNDARY) ||
      CHUNK_UNSAFE_PATTERN_SOURCES.has(raw))
  ) {
    chunkUnsafePatterns.add(pattern);
  }
  return pattern;
}

function resolvePatterns(value?: readonly RedactPattern[]): ResolvedRedactPattern[] {
  if (value === TOOL_PAYLOAD_REDACT_PATTERNS) {
    toolPayloadResolvedPatterns ??= TOOL_PAYLOAD_REDACT_PATTERNS.map(parsePattern).filter(
      (re): re is ResolvedRedactPattern => Boolean(re),
    );
    return toolPayloadResolvedPatterns;
  }
  if (!value?.length || value === DEFAULT_REDACT_PATTERNS) {
    defaultResolvedPatterns ??= DEFAULT_REDACT_PATTERNS.map(parsePattern).filter(
      (re): re is ResolvedRedactPattern => Boolean(re),
    );
    return defaultResolvedPatterns;
  }
  return [
    ...new Set([
      ...value.map(parsePattern).filter((re): re is ResolvedRedactPattern => Boolean(re)),
      AWS_SECRET_ACCESS_KEY_MATCHER,
    ]),
  ];
}

function usesBuiltInRedactPatterns(value?: readonly RedactPattern[]): boolean {
  return (
    !value?.length || value === DEFAULT_REDACT_PATTERNS || value === TOOL_PAYLOAD_REDACT_PATTERNS
  );
}

function maskToken(token: string): string {
  if (token === "***") {
    return token;
  }
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = sliceUtf16Safe(token, 0, DEFAULT_REDACT_KEEP_START);
  const end = sliceUtf16Safe(token, -DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function splitSecretValueForMask(token: string): {
  maskable: string;
  suffix: string;
  maskStart: number;
  maskEnd: number;
} {
  const openingQuote = token[0] ?? "";
  if (SECRET_VALUE_QUOTE_CHARS.has(openingQuote)) {
    const closingQuoteIndex = token.lastIndexOf(openingQuote);
    if (closingQuoteIndex > 0) {
      const suffix = token.slice(closingQuoteIndex + 1);
      if (SECRET_VALUE_SUFFIX_RE.test(suffix)) {
        return {
          maskable: token.slice(1, closingQuoteIndex),
          suffix,
          maskStart: 0,
          maskEnd: closingQuoteIndex + 1,
        };
      }
    }

    const tokenWithoutLeadingQuote = token.slice(1);
    const trailingDelimiter =
      tokenWithoutLeadingQuote.match(SECRET_VALUE_TRAILING_DELIMITER_RE)?.[1] ?? "";
    const maskable =
      trailingDelimiter && trailingDelimiter.length < tokenWithoutLeadingQuote.length
        ? tokenWithoutLeadingQuote.slice(0, -trailingDelimiter.length)
        : tokenWithoutLeadingQuote;
    return {
      maskable,
      suffix:
        trailingDelimiter && trailingDelimiter.length < tokenWithoutLeadingQuote.length
          ? trailingDelimiter
          : "",
      maskStart: 0,
      maskEnd: 1 + maskable.length,
    };
  }

  const trailingDelimiter = token.match(SECRET_VALUE_TRAILING_DELIMITER_RE)?.[1] ?? "";
  const maskable =
    trailingDelimiter && trailingDelimiter.length < token.length
      ? token.slice(0, -trailingDelimiter.length)
      : token;
  return {
    maskable,
    suffix: maskable === token ? "" : trailingDelimiter,
    maskStart: 0,
    maskEnd: maskable.length,
  };
}

function splitFormAwareCredentialValue(token: string): { secret: string; suffix: string } {
  const pairBoundary = token.search(/&[A-Za-z_][A-Za-z0-9_.-]*=/u);
  return pairBoundary < 0
    ? { secret: token, suffix: "" }
    : { secret: token.slice(0, pairBoundary), suffix: token.slice(pairBoundary) };
}

function maskSecretValue(token: string, options?: { hinted?: boolean }): string {
  const { maskable, suffix } = splitSecretValueForMask(token);
  return `${options?.hinted ? maskToken(maskable) : "***"}${suffix}`;
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
  return isSensitiveUrlQueryParamName(key) || BODY_SECRET_KEYS.has(normalizeSensitiveKeyName(key));
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

function markBitmapRange(bitmap: boolean[], start: number, end: number): void {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(bitmap.length, end);
  for (let i = boundedStart; i < boundedEnd; i++) {
    bitmap[i] = true;
  }
}

function markAssignmentValues(
  text: string,
  kind: SensitiveAssignmentKind,
  bitmap: boolean[],
  offset = 0,
): void {
  visitSensitiveAssignments(text, kind, (start, end) => {
    markBitmapRange(bitmap, offset + start, offset + end);
  });
}

function redactFormBodyLine(text: string, onEdits?: PreparationEditSink): string {
  if (!text) {
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
  if (!text) {
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

function markFormBodyLineRedactions(text: string, bitmap: boolean[], offset: number): void {
  if (!text) {
    return;
  }
  markAssignmentValues(text, "encoded", bitmap, offset);
  markAssignmentValues(text, "context", bitmap, offset);
  if (!text.includes("&")) {
    return;
  }
  if (FORM_BODY_RE.test(text)) {
    markAssignmentValues(text, "form", bitmap, offset);
    return;
  }
  for (const match of text.matchAll(FORM_BODY_SUBSTRING_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const prefix = match[1] ?? "";
    const body = match[2] ?? "";
    markAssignmentValues(body, "form", bitmap, offset + match.index + prefix.length);
  }
}

function markFormBodyRedactions(text: string, bitmap: boolean[]): void {
  if (!text) {
    return;
  }
  if (!FORM_BODY_LINE_BREAK_SPLIT_RE.test(text)) {
    markFormBodyLineRedactions(text, bitmap, 0);
    return;
  }
  let offset = 0;
  for (const segment of text.split(FORM_BODY_LINE_BREAK_SPLIT_RE)) {
    if (!FORM_BODY_LINE_BREAK_SEGMENT_RE.test(segment)) {
      markFormBodyLineRedactions(segment, bitmap, offset);
    }
    offset += segment.length;
  }
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

function readEnvAssignmentKey(match: string): string | undefined {
  return match.match(/\b([A-Z_][A-Z0-9_]*)\b\s*[=:]/)?.[1];
}

function shouldPreserveShellReferenceMatch(match: string, token: string): boolean {
  const key = readEnvAssignmentKey(match);
  return key ? isShellReferenceToKey(key, token) : false;
}

function isEmptyShellParameterExpansionTail(token: string): boolean {
  return /^[-=?+]\}$/.test(token);
}

function hasBackreferenceToGroup(pattern: RegExp, groupNumber: number): boolean {
  return new RegExp(String.raw`\\${groupNumber}(?!\d)`).test(pattern.source);
}

type SecretCaptureSelection = {
  captureCount: number;
  index: number;
  value: string;
};

function selectSecretCapture(match: string, groups: string[]): SecretCaptureSelection {
  const selected = { index: -1, value: match, captureCount: 0 };
  for (let index = 0; index < groups.length; index++) {
    const value = groups[index];
    if (typeof value === "string" && value.length > 0) {
      selected.index = index;
      selected.value = value;
      selected.captureCount++;
    }
  }
  return selected;
}

function getIndexedCaptureStart(
  pattern: ResolvedRedactPattern,
  input: string,
  match: string,
  matchOffset: number,
  captureIndex: number,
): number | null {
  if (!(pattern instanceof RegExp) || matchOffset < 0 || !input) {
    return null;
  }
  try {
    const flags = pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`;
    const indexedPattern = new RegExp(pattern.source, flags);
    indexedPattern.lastIndex = matchOffset;
    const indexedMatch = indexedPattern.exec(input) as
      | (RegExpExecArray & { indices?: Array<[number, number] | undefined> })
      | null;
    const captureIndices = indexedMatch?.indices?.[captureIndex + 1];
    if (!indexedMatch || indexedMatch.index !== matchOffset || indexedMatch[0] !== match) {
      return null;
    }
    if (!captureIndices) {
      return null;
    }
    return captureIndices[0] - matchOffset;
  } catch {
    return null;
  }
}

function getSecretCaptureStart(
  pattern: ResolvedRedactPattern,
  input: string,
  match: string,
  matchOffset: number,
  selected: SecretCaptureSelection,
): number {
  const indexedTokenStart = getIndexedCaptureStart(
    pattern,
    input,
    match,
    matchOffset,
    selected.index,
  );
  if (indexedTokenStart !== null) {
    return indexedTokenStart;
  }
  const preferFirstCapture =
    pattern instanceof RegExp &&
    selected.captureCount === 1 &&
    selected.index >= 0 &&
    hasBackreferenceToGroup(pattern, selected.index + 1);
  return preferFirstCapture ? match.indexOf(selected.value) : match.lastIndexOf(selected.value);
}

function getRedactionEdit(
  { match, groups, input, offset, replacement: policyReplacement }: RedactMatch,
  pattern: ResolvedRedactPattern,
  preserveSourceAssignment?: (text: string, offset: number) => boolean,
  project?: (start: number, end: number) => RedactionTarget | undefined,
): RedactionEdit | undefined {
  if (match.includes("PRIVATE KEY-----")) {
    const target = project
      ? project(offset, offset + match.length)
      : { start: offset, end: offset + match.length, value: match };
    return (
      target && {
        ...target,
        replacement: policyReplacement ?? redactPemBlock(target.value, "…redacted…"),
      }
    );
  }
  const selected = selectSecretCapture(match, groups);
  const tokenIndex =
    selected.value === match ? 0 : getSecretCaptureStart(pattern, input, match, offset, selected);
  if (tokenIndex < 0) {
    return undefined;
  }
  const start = offset + tokenIndex;
  const target = project
    ? project(start, start + selected.value.length)
    : { start, end: start + selected.value.length, value: selected.value };
  if (!target) {
    return undefined;
  }
  const token = target.value;
  if (
    sourceAssignmentPatterns.has(pattern) &&
    preserveSourceAssignment?.(
      input,
      offset + getSecretCaptureStart(pattern, input, match, offset, selected),
    )
  ) {
    return undefined;
  }
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
    (shouldPreserveShellReferenceMatch(match, token) || isEmptyShellParameterExpansionTail(token))
  ) {
    return undefined;
  }
  // Assignment values can legitimately include trailing shell/structural characters
  // (e.g. `${VAR:-default}`); mask the captured token whole so those characters count toward the
  // retained hint instead of being exposed by delimiter-aware masking.
  // Source goes through both the guard and SQLite. Full assignment masks keep
  // those copies identical; diagnostic hints otherwise shrink on the second pass.
  const masked =
    policyReplacement ??
    (preserveSourceAssignment && sourceAssignmentPatterns.has(pattern)
      ? maskSecretValue(token)
      : isShellReferencePattern
        ? maskToken(token)
        : `${maskSecretValue(formAwareValue.secret, { hinted: true })}${formAwareValue.suffix}`);
  return { start: target.start, end: target.end, replacement: masked };
}

function redactMatch(
  match: RedactMatch,
  pattern: ResolvedRedactPattern,
  preserveSourceAssignment?: (text: string, offset: number) => boolean,
): string {
  const edit = getRedactionEdit(match, pattern, preserveSourceAssignment);
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
    preserveSourceAssignment?: (text: string, offset: number) => boolean;
  },
): string {
  const finishMeasurement = startRedactionMeasurement("text");
  let outcome: "ok" | "error" = "error";
  try {
    let next = redactFormBody(
      redactAssignmentValues(redactStructuredAuthHeaders(text, "***"), "url"),
    );
    let pattern: ResolvedRedactPattern;
    const replace = (match: RedactMatch) =>
      redactMatch(match, pattern, options?.preserveSourceAssignment);
    const replaceRegex = (...args: unknown[]) => replace(readRedactMatch(args));
    // Each replacement finishes synchronously before this invocation advances its pattern.
    for (pattern of patterns) {
      next =
        pattern instanceof RegExp && !options?.fullContext && !chunkUnsafePatterns.has(pattern)
          ? replacePatternBounded(next, pattern, replaceRegex)
          : replaceRedactPattern(next, pattern, replace, replaceRegex);
    }
    outcome = "ok";
    return next;
  } finally {
    finishMeasurement?.(outcome, text.length, patterns.length);
  }
}

function couldMatchDefaultRedactPatterns(text: string): boolean {
  return DEFAULT_REDACT_PREFILTER_RE.test(text) || AWS_SECRET_ACCESS_KEY_MATCHER.couldMatch(text);
}

function couldMatchDefaultFullContextPatterns(text: string): boolean {
  return couldMatchDefaultRedactPatterns(text) || FULL_CONTEXT_REDACT_EXTRA_TRIGGERS_RE.test(text);
}

function markPatternMatchRedaction(
  bitmap: boolean[],
  input: string,
  pattern: ResolvedRedactPattern,
  match: RedactMatch,
): void {
  const fullMatch = match.match;
  if (fullMatch.includes("PRIVATE KEY-----")) {
    markBitmapRange(bitmap, match.offset, match.offset + fullMatch.length);
    return;
  }
  const selected = selectSecretCapture(fullMatch, match.groups);
  const tokenStart =
    selected.value === fullMatch
      ? 0
      : getSecretCaptureStart(pattern, input, fullMatch, match.offset, selected);
  if (tokenStart < 0) {
    return;
  }
  const selectedSecret = formAwareEqualsAssignmentPatterns.has(pattern)
    ? splitFormAwareCredentialValue(selected.value).secret
    : selected.value;
  const secretValue = splitSecretValueForMask(selectedSecret);
  markBitmapRange(
    bitmap,
    match.offset + tokenStart + secretValue.maskStart,
    match.offset + tokenStart + secretValue.maskEnd,
  );
}

export function computeSensitiveRedactionBitmap(
  text: string,
  resolved: ResolvedRedactOptions,
): boolean[] {
  // oxlint-disable-next-line unicorn/no-new-array -- Fill the dense bitmap without a callback for every character.
  const bitmap = new Array<boolean>(text.length).fill(false);
  if (resolved.mode === "off" || !text) {
    return bitmap;
  }
  for (const range of findStructuredAuthParamRanges(text)) {
    markBitmapRange(bitmap, range.start, range.end);
  }
  markAssignmentValues(text, "url", bitmap);
  markFormBodyRedactions(text, bitmap);
  for (const pattern of resolved.patterns) {
    for (const match of iterateRedactMatches(text, pattern)) {
      markPatternMatchRedaction(bitmap, text, pattern, match);
    }
  }
  return bitmap;
}

function looksLikeAppSpecificPassword(candidate: string): boolean {
  return candidate.split("-").every((part) => !BENIGN_APP_PASSWORD_WORDS.has(part.toLowerCase()));
}

function redactAppSpecificPasswords(text: string): string {
  return replacePatternBounded(text, APP_SPECIFIC_PASSWORD_RE, (match: string, token: string) =>
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
  const mode = normalizeMode(resolved.mode);
  if (mode === "off") {
    return {
      mode,
      patterns: [],
    };
  }
  return { mode, patterns: resolvePatterns(resolved.patterns) };
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const exactRedacted = redactRegisteredSecretValues(text, maskToken);
  return redactSensitiveTextWithOptions(exactRedacted, options ?? resolveConfigRedaction());
}

export type SensitiveTextRedactionSnapshot = {
  readonly registryRevision: number;
  readonly registeredSecretValues: readonly string[];
};

/** Captures the built-in tools-mode policy used by session preparation. Never log this snapshot. */
export function captureSensitiveTextRedactionSnapshot(): SensitiveTextRedactionSnapshot {
  const { revision, values } = captureSecretRedactionRegistrySnapshot();
  return { registryRevision: revision, registeredSecretValues: values };
}

export function createSensitiveTextRedactor(
  snapshot: SensitiveTextRedactionSnapshot,
): (text: string) => string {
  const redactExactValues = createSecretValueRedactor(snapshot.registeredSecretValues);
  const options: RedactOptions = { mode: "tools" };
  return (text) => redactSensitiveTextWithOptions(redactExactValues(text, maskToken), options);
}

function redactSensitiveTextWithOptions(
  exactRedacted: string,
  resolvedOptions: RedactOptions,
): string {
  if (normalizeMode(resolvedOptions.mode) === "off") {
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
    userPatterns && userPatterns.length > 0
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : undefined;
  return { mode: "tools", patterns };
}

function resolveModelVisibleToolPayloadRedaction(
  loggingConfig: LoggingConfig | undefined = readLoggingConfig(),
): RedactOptions {
  const userPatterns = loggingConfig?.redactPatterns;
  const hasUserPatterns = userPatterns && userPatterns.length > 0;
  return {
    mode: "tools",
    patterns: hasUserPatterns
      ? [...userPatterns, ...TOOL_PAYLOAD_REDACT_PATTERNS]
      : TOOL_PAYLOAD_REDACT_PATTERNS,
    sensitiveFieldPatterns: hasUserPatterns
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : DEFAULT_REDACT_PATTERNS,
  };
}

// Forces tools-mode so UI/tool payloads never inherit a caller-supplied "off"
// mode, and merges user `logging.redactPatterns` with the built-in defaults so
// both apply.
export function redactToolPayloadText(text: string): string {
  return redactToolPayloadTextWithConfig(text, readLoggingConfig());
}

function redactToolPayloadTextWithPolicy(
  text: string,
  loggingConfig: LoggingConfig | undefined,
  options: RedactOptions,
): string {
  if (!text) {
    return text;
  }
  if (!isFullContextToolPayloadRedaction(loggingConfig)) {
    return redactSensitiveText(text, options);
  }
  const resolved = resolveRedactOptions(options);
  return redactText(redactRegisteredSecretValues(text, maskToken), resolved.patterns, {
    fullContext: true,
  });
}

export function redactToolPayloadTextWithConfig(
  text: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactToolPayloadTextWithPolicy(
    text,
    loggingConfig,
    resolveToolPayloadRedaction(loggingConfig),
  );
}

/** Input source retains computations, but uses diagnostic credential masking, not output policy. */
export function redactInputTextWithSourcePolicy(
  text: string,
  loggingConfig: LoggingConfig | undefined,
  preserveSourceAssignment: (text: string, offset: number) => boolean,
): string {
  // Custom patterns run without syntax exemptions, even when identical to a built-in pattern.
  const customPatterns = loggingConfig?.redactPatterns;
  const prepared = customPatterns?.length
    ? redactSensitiveText(text, { mode: "tools", patterns: customPatterns })
    : redactRegisteredSecretValues(text, maskToken);
  return redactText(prepared, resolvePatterns(), {
    fullContext: true,
    preserveSourceAssignment,
  });
}

// Model-visible tool output commonly contains source code, so its assignment matching is
// intentionally narrower than diagnostic and logging redaction.
export function redactModelVisibleToolPayloadText(text: string): string {
  return redactModelVisibleToolPayloadTextWithConfig(text, readLoggingConfig());
}

/** Owns the admitted text and its provenance so persistence can reuse its exact bytes. */
export function prepareModelVisibleToolTextBlock<T extends { type: "text"; text: string }>(
  block: T,
  loggingConfig: LoggingConfig = readLoggingConfig(),
): T {
  if (modelVisibleToolTextRedactionState.matches(block, block.text, loggingConfig)) {
    return block;
  }
  const prepared = {
    ...block,
    text: redactModelVisibleSensitiveFieldValueWithConfig("text", block.text, loggingConfig),
  };
  modelVisibleToolTextRedactionState.record(prepared, prepared.text, loggingConfig);
  return prepared;
}

export function redactModelVisibleToolPayloadTextWithConfig(
  text: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactToolPayloadTextWithPolicy(
    text,
    loggingConfig,
    resolveModelVisibleToolPayloadRedaction(loggingConfig),
  );
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
): string {
  const exactRedacted = redactRegisteredSecretValues(value, maskToken);
  if (isPublicShareIdPath(path)) {
    return maskToken(exactRedacted);
  }
  const sensitiveKey = isSensitiveFieldKey(key);
  const fieldOptions =
    sensitiveKey && options.sensitiveFieldPatterns
      ? { ...options, patterns: options.sensitiveFieldPatterns }
      : options;
  const resolved = resolveRedactOptions(fieldOptions);
  if (resolved.mode === "off") {
    return exactRedacted;
  }
  // Structured payloads can contain thousands of short, benign strings. Avoid
  // walking the full default pattern table for each one; the prefilter is kept
  // in sync with every built-in pattern and sensitive form/URL key. Explicit
  // user patterns still require the full scan because they have no prefilter.
  const redacted =
    !usesBuiltInRedactPatterns(fieldOptions.patterns) ||
    couldMatchDefaultRedactPatterns(exactRedacted)
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

export function redactSensitiveFieldValueWithConfig(
  key: string,
  value: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactSensitiveFieldValueWithOptions(
    key,
    value,
    resolveToolPayloadRedaction(loggingConfig),
  );
}

export function redactModelVisibleSensitiveFieldValueWithConfig(
  key: string,
  value: string,
  loggingConfig?: LoggingConfig,
): string {
  return redactSensitiveFieldValueWithOptions(
    key,
    value,
    resolveModelVisibleToolPayloadRedaction(loggingConfig),
  );
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
  path: readonly string[] = key ? [key] : [],
  objectPath = true,
): unknown {
  if (typeof value === "string") {
    return redactSensitiveFieldValueWithOptions(key, value, options, path, objectPath);
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
      redactStructuredSecretValue(key, entry, seen, options, path, false),
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
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  return redactStructuredSecretValue("", value, new WeakSet<object>(), options) as T;
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
  return legacy ? "legacy" : CREDENTIAL_HEADER_FIELD_RE.test(key) ? "header" : undefined;
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

function getLegacyFieldRecordEdits(
  field: RedactionField,
  value: string,
  beforeConversion = false,
): RedactionEdit[] {
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
  return protection === "legacy" || (beforeConversion && protection === "header")
    ? [{ start: 0, end: value.length, replacement: maskToken(value) }]
    : [];
}

export function resolveFileLogRedactOptions(): ResolvedRedactOptions {
  return resolveRedactOptions(resolveToolPayloadRedaction());
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
      for (const edit of edits) {
        yield {
          match: input.slice(edit.start, edit.end),
          groups: [],
          input,
          offset: edit.start,
          replacement: edit.replacement,
        };
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
      for (const edit of edits) {
        yield {
          match: input.slice(edit.start, edit.end),
          groups: [],
          input,
          offset: edit.start,
          replacement: edit.replacement,
        };
      }
    },
  },
];
const CONSOLE_STRUCTURAL_FIELDS = new Set(["time", "level"]);

function prepareFileToJsonReceivers(
  record: Record<string, unknown>,
  patterns: ResolvedRedactPattern[],
) {
  const decoded = new WeakSet<object>();
  const active = new WeakSet<object>();
  const visit = (
    value: unknown,
    key: string,
    path: string[],
    objectPath: boolean,
    decode: boolean,
  ): unknown => {
    if (typeof value === "string" && decode) {
      const field: RedactionField = {
        key,
        path,
        objectPath,
        value,
        isKey: false,
        string: true,
        origin: { structured: true, primitiveMask: false },
      };
      let current = applyRedactionEdits(value, getTextRecordEdits(field, "tools", true));
      if (!isPublicShareIdPath(path)) {
        for (const pattern of patterns) {
          current = applyRedactionEdits(
            current,
            getPatternRedactionEdits(current, pattern, (match, rule, project) =>
              getRedactionEdit(match, rule, undefined, project),
            ),
          );
        }
      }
      return applyRedactionEdits(current, getLegacyFieldRecordEdits(field, current, true));
    }
    if (value === null || typeof value !== "object") {
      return decode &&
        ["number", "boolean", "bigint"].includes(typeof value) &&
        classifyLogFieldProtection(key, path, objectPath, undefined)
        ? "***"
        : value;
    }
    if (!Array.isArray(value) && !isPlainRedactableObject(value)) {
      return value;
    }
    if (active.has(value)) {
      return "[Circular]";
    }
    active.add(value);
    let clone: object;
    let decodeFields = decode;
    if (Array.isArray(value)) {
      clone = value.map((entry) => visit(entry, key, path, false, decodeFields));
    } else {
      const entries = Object.entries(value);
      decodeFields ||= entries.some(
        ([name, entry]) => name === "toJSON" && typeof entry === "function",
      );
      clone = Object.fromEntries(
        entries.map(([name, entry]) => [
          name,
          visit(entry, name, [...path, name], objectPath, decodeFields),
        ]),
      );
    }
    if (decodeFields) {
      decoded.add(clone);
    }
    active.delete(value);
    return clone;
  };
  return { record: visit(record, "", [], true, false), decoded };
}

/** Converts native values once and applies configured and structural protection before output. */
export function redactLogRecordForTransport(
  record: Record<string, unknown>,
  options: {
    format?: "file" | "console";
    deriveMessage?: (record: Record<string, unknown>) => RedactionMessage | undefined;
    decodedOptions?: ResolvedRedactOptions;
  } = {},
): Record<string, unknown> {
  const finishMeasurement = startRedactionMeasurement("log-record");
  let outcome: "ok" | "error" = "error";
  let inputChars: number | undefined;
  try {
    const resolved = resolveRedactOptions();
    const prepared =
      options.format === "console"
        ? { record, decoded: new WeakSet<object>() }
        : prepareFileToJsonReceivers(record, options.decodedOptions?.patterns ?? resolved.patterns);
    const ordinary = { structured: true, primitiveMask: false };
    const origins: RedactionOrigins = { value: ordinary, children: new Map() };
    const ancestors: {
      value: object;
      path: string[];
      key: string;
      origins: RedactionOrigins;
      structured: boolean;
    }[] = [];
    const json = JSON.stringify(prepared.record, function (this: object, key, value: unknown) {
      while (ancestors.length > 0 && ancestors.at(-1)?.value !== this) {
        ancestors.pop();
      }
      const parent = ancestors.at(-1);
      const array = Array.isArray(this);
      const fieldKey = array && parent ? parent.key : key;
      const path = array && parent ? parent.path : parent ? [...parent.path, key] : [];
      // Prepared plain holders contain data properties; native holders need no legacy field walk.
      const source: unknown = !parent
        ? prepared.record
        : parent.structured && options.format !== "console"
          ? Reflect.get(this, key)
          : value;
      const structured =
        (parent?.structured ?? true) &&
        (source === null ||
          typeof source !== "object" ||
          (!prepared.decoded.has(source) &&
            source === value &&
            (Array.isArray(source) || isPlainRedactableObject(source))));
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
    let materialized: Record<string, unknown> = JSON.parse(json);
    const message = options.deriveMessage?.(materialized);
    if (message) {
      origins.children.set("message", { value: ordinary, children: new Map() });
      if (Object.hasOwn(materialized, "message")) {
        materialized.message = message.text;
      } else {
        // Serialized-context rules observe the file message immediately after hostname.
        const entries = Object.entries(materialized);
        entries.splice(entries.findIndex(([key]) => key === "hostname") + 1, 0, [
          "message",
          message.text,
        ]);
        materialized = Object.fromEntries(entries);
      }
    }
    const serialized = message ? JSON.stringify(materialized) : json;
    const decodedPatterns = options.decodedOptions?.patterns ?? resolved.patterns;
    const result: Record<string, unknown> = JSON.parse(
      redactJsonRecord(
        serialized,
        origins,
        [
          [{ patterns: decodedPatterns }],
          [
            { patterns: preparationPatterns },
            {
              patterns: resolved.patterns,
              ...(resolved.patterns === defaultResolvedPatterns
                ? { couldMatch: couldMatchDefaultFullContextPatterns }
                : {}),
            },
          ],
        ],
        (match, pattern, project) => getRedactionEdit(match, pattern, undefined, project),
        options.format === "console" ? () => [] : getLegacyFieldRecordEdits,
        (field) => getFieldRecordEdits(field, resolved.mode),
        (field) => getTextRecordEdits(field, resolved.mode, options.format !== "console"),
        (field, currentValue) =>
          (options.format === "console"
            ? field.path.length === 1 && CONSOLE_STRUCTURAL_FIELDS.has(field.key)
            : !field.origin.structured ||
              field.origin.primitiveMask ||
              isPublicShareIdPath(field.path)) ||
          (decodedPatterns === defaultResolvedPatterns &&
            !couldMatchDefaultFullContextPatterns(currentValue)),
        message,
      ),
    );
    outcome = "ok";
    return result;
  } finally {
    finishMeasurement?.(outcome, inputChars);
  }
}

export function redactModelVisibleSecrets<T>(value: T): T {
  return redactSecretsWithOptions(value, resolveModelVisibleToolPayloadRedaction());
}

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_STRING_PATTERNS];
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
  return redactJsonRecord(
    lines.join("\n"),
    { value: { structured: false, primitiveMask: false }, children: new Map() },
    [[], [{ patterns: [...preparationPatterns, ...resolved.patterns] }]],
    (match, pattern, project) => getRedactionEdit(match, pattern, undefined, project),
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
