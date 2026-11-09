import { findStructuredAuthParamRanges } from "../../packages/acp-core/src/structured-auth-redaction.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "./config.js";
import { getFileLogRedactionMessage } from "./logger-file-message.js";
import {
  applyRedactionEdits,
  composeRedactionEdits,
  type RedactionEdit,
} from "./redact-edit-composition.js";
import {
  redactJsonRecord,
  type RedactionMessage,
  type RedactionField,
  type RedactionOrigins,
} from "./redact-json.js";
import { maskToken } from "./redact-mask.js";
import type {
  RedactMatch,
  RedactPattern,
  ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";
import {
  AWS_SECRET_ACCESS_KEY_FIELD_KEYS,
  DEFAULT_REDACT_PATTERNS,
  PAYMENT_CREDENTIAL_ENV_KEYS,
  PAYMENT_CREDENTIAL_JSON_KEYS,
  PAYMENT_CREDENTIAL_QUERY_KEYS,
} from "./redact-patterns.js";
import { PEM_REDACT_MATCHER, PEM_REDACT_PATTERN_SOURCE } from "./redact-pem.js";
import { startRedactionMeasurement } from "./redact-performance.js";
import {
  couldMatchDefaultFullContextPatterns,
  couldMatchDefaultRedactPatterns,
  createRedactPrefilter,
} from "./redact-prefilter.js";
import {
  getDefaultResolvedRedactPatterns,
  isCredentialHeaderField,
  isShellReferenceToKey,
  prepareRedactionCapture,
  redactAssignmentValues,
  redactFormBody,
  redactText,
  resolvePatterns,
  usesBuiltInRedactPatterns,
  type PreparationEditSink,
} from "./redact-text.js";
import { redactRegisteredSecretValues } from "./secret-redaction-registry.js";
import { shouldRedactStructuredAuthorizationCode } from "./structured-authorization-code.js";

export { redactText } from "./redact-text.js";

type RedactSensitiveMode = "off" | "tools";
type LoggingConfig = OpenClawConfig["logging"];

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
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

function maskSecretFieldValue(key: string, value: string): string {
  const expansion = value.match(/^\$\{([A-Z_][A-Z0-9_]*):[-=?+][^{}]+\}(?![\s\S])/);
  if (expansion && expansion[1] === key) {
    return `${value.slice(0, value.indexOf(":") + 2)}***}`;
  }
  return "***";
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
  return legacy ? "legacy" : isCredentialHeaderField(key) ? "header" : undefined;
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
    const defaultResolvedPatterns = getDefaultResolvedRedactPatterns();
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
  const defaultResolvedPatterns = getDefaultResolvedRedactPatterns();
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
