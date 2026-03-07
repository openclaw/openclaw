/**
 * Input validation pipeline — Stage 1A (syntactic pre-filter) and
 * Stage 1B (schema validation).
 *
 * Both stages are pure functions: no I/O, no model calls, no external
 * dependencies. runPreFilter() evaluates both stages and merges their
 * results before the two-pass gating decision.
 *
 * Design principle: err toward false negatives, not false positives.
 * These filters catch low-effort / automated attacks cheaply. Sophisticated
 * adversaries can bypass syntactic patterns — the semantic sub-agent (Stage 2)
 * is the primary trust boundary.
 */

import type {
  PreFilterResult,
  SchemaValidationResult,
  SyntacticFilterResult,
  ToolOutputSchema,
} from "./types.js";

// ---------------------------------------------------------------------------
// Versioned pattern constants (MUST NOT be loaded from config to prevent
// config-injection attacks on the filter itself)
// ---------------------------------------------------------------------------

// Common Cyrillic/Greek homoglyphs for basic normalization before pattern check.
// Maps look-alike Unicode characters to their ASCII equivalents.
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map([
  ["\u0430", "a"], // Cyrillic а → a
  ["\u0435", "e"], // Cyrillic е → e
  ["\u043E", "o"], // Cyrillic о → o
  ["\u0440", "p"], // Cyrillic р → p
  ["\u0441", "c"], // Cyrillic с → c
  ["\u0445", "x"], // Cyrillic х → x
  ["\u0443", "y"], // Cyrillic у → y
  ["\u0456", "i"], // Cyrillic і → i
  ["\u03BF", "o"], // Greek ο (omicron) → o
  ["\u03B1", "a"], // Greek α → a
  ["\u03B5", "e"], // Greek ε → e
  ["\u0000", ""], // null byte → strip
]);

// Injection patterns that map to rule IDs.
// Each entry: [regex, ruleId]. Order matters: first match wins for ruleId.
const INJECTION_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // injection.ignore-previous
  [/ignore\s+(previous|all)\s+instructions/i, "injection.ignore-previous"],
  [/disregard\s+your/i, "injection.ignore-previous"],
  // injection.system-override
  [/new\s+instructions\s*:/i, "injection.system-override"],
  [/system\s+override/i, "injection.system-override"],
  [/\bSYSTEM\s*:/, "injection.system-override"], // all-caps, not case-insensitive
  [/\[INST\]/i, "injection.system-override"],
  [/<\/INST>/i, "injection.system-override"],
  [/\byou\s+are\s+now\b/i, "injection.system-override"],
];

// Role-switch trigger phrases (any one present activates the role-switch check).
const ROLE_SWITCH_TRIGGERS: ReadonlyArray<RegExp> = [
  /\byou\s+are\s+a\b/i,
  /\bact\s+as\b/i,
  /\bpretend\s+you\s+are\b/i,
  /\broleplay\s+as\b/i,
];

// Capability-granting phrases (any one present, combined with a role-switch
// trigger, triggers injection.role-switch-capability).
const CAPABILITY_GRANTS: ReadonlyArray<RegExp> = [
  /\bno\s+restrictions\b/i,
  /\bno\s+limits\b/i,
  /\bwithout\s+filters?\b/i,
  /\bDAN\s+mode\b/i,
  /\bdeveloper\s+mode\b/i,
];

// Base64 pattern: string of base64 chars ≥ 30 chars (roughly ≥ 22 raw bytes),
// tolerating whitespace between chunks. Excludes field names that legitimately
// hold binary content.
const BASE64_CONTENT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_MIN_LEN = 60; // below this length, false-positive rate too high
const KNOWN_BINARY_FIELD_NAMES = new Set([
  "data",
  "binary",
  "blob",
  "content",
  "image",
  "attachment",
  "file",
  "bytes",
  "raw",
  "payload",
]);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Apply basic homoglyph normalization — replace look-alike Unicode characters
 * with their ASCII equivalents. Returns a new string if any replacements were
 * made, otherwise returns the input reference unchanged.
 */
function normalizeHomoglyphs(text: string): string {
  let changed = false;
  let result = text;
  for (const [glyph, replacement] of HOMOGLYPH_MAP) {
    if (result.includes(glyph)) {
      result = result.replaceAll(glyph, replacement);
      changed = true;
    }
  }
  return changed ? result : text;
}

/**
 * Recursively compute the maximum JSON nesting depth of a value.
 * Objects and arrays contribute one level each.
 */
function measureJsonDepth(value: unknown, current = 0): number {
  if (value === null || typeof value !== "object") {
    return current;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return current + 1;
    let max = current + 1;
    for (const item of value) {
      const depth = measureJsonDepth(item, current + 1);
      if (depth > max) max = depth;
    }
    return max;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return current + 1;
  let max = current + 1;
  for (const key of keys) {
    const depth = measureJsonDepth((value as Record<string, unknown>)[key], current + 1);
    if (depth > max) max = depth;
  }
  return max;
}

/**
 * Test whether a string contains non-UTF8 / binary content by checking for
 * null bytes or replacement characters that indicate encoding issues.
 */
function hasBinaryContent(text: string): boolean {
  // Null bytes or Unicode replacement character (U+FFFD, used when decoding fails)
  return text.includes("\x00") || text.includes("\uFFFD");
}

/**
 * Test whether a string looks like a base64-encoded payload. Only flags strings
 * that are long enough to represent meaningful data and purely base64-charset.
 */
function looksLikeBase64(text: string, fieldName?: string): boolean {
  if (fieldName && KNOWN_BINARY_FIELD_NAMES.has(fieldName.toLowerCase())) {
    return false;
  }
  const stripped = text.replace(/\s/g, "");
  if (stripped.length < BASE64_MIN_LEN) return false;
  return BASE64_CONTENT_RE.test(stripped);
}

type StringLeaf = { value: string; fieldName?: string };

/**
 * Recursively collect all string leaf values from an object or value.
 * Tracks the immediate parent field name for base64 context.
 */
function collectStringLeaves(value: unknown, parentKey?: string): StringLeaf[] {
  if (typeof value === "string") {
    return [{ value, fieldName: parentKey }];
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const leaves: StringLeaf[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const leaf of collectStringLeaves(item)) {
        leaves.push(leaf);
      }
    }
  } else {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      for (const leaf of collectStringLeaves(v, k)) {
        leaves.push(leaf);
      }
    }
  }
  return leaves;
}

/**
 * Serialize input to a string for pattern matching.
 * Objects are converted to their string leaves joined by space.
 * The raw serialized form is also returned for size checks.
 */
function serializeForPatternCheck(input: unknown): { text: string; rawBytes: number } {
  if (typeof input === "string") {
    return { text: input, rawBytes: Buffer.byteLength(input, "utf8") };
  }
  let raw: string;
  try {
    raw = JSON.stringify(input) ?? "";
  } catch {
    raw = String(input);
  }
  const leaves = collectStringLeaves(input);
  const text = leaves.map((l) => l.value).join(" ");
  return { text, rawBytes: Buffer.byteLength(raw, "utf8") };
}

// ---------------------------------------------------------------------------
// Stage 1A — Syntactic pre-filter
// ---------------------------------------------------------------------------

export type SyntacticConfig = {
  enabled: boolean;
  maxPayloadBytes: number;
  maxJsonDepth: number;
  /** Rule IDs demoted to flags-only by the active context profile. These rules still fire and appear in flags/ruleIds, but do not set pass: false. hardBlockRules in the twoPass config take precedence over this. */
  suppressRules?: string[];
};

/**
 * Stage 1A: syntactic pre-filter.
 *
 * Pure function — no I/O, no model calls, no side effects.
 * Checks known injection patterns, structural anomalies, and encoding tricks.
 *
 * Returns pass: true when nothing definitive was detected.
 * A PASS here does not mean the content is safe — the semantic sub-agent
 * is the primary trust boundary for novel and obfuscated attacks.
 */
export function syntacticPreFilter(input: unknown, config: SyntacticConfig): SyntacticFilterResult {
  if (!config.enabled) {
    return { pass: true, flags: [], ruleIds: [] };
  }

  const flags: string[] = [];
  const ruleIds: string[] = [];
  const suppressSet = new Set(config.suppressRules ?? []);
  let blockingFlagCount = 0;

  function addFlag(ruleId: string, description: string): void {
    if (!ruleIds.includes(ruleId)) ruleIds.push(ruleId);
    flags.push(description);
    if (!suppressSet.has(ruleId)) {
      blockingFlagCount++;
    }
  }

  // --- Size check (operates on raw bytes before any string extraction) ---
  const { text: rawText, rawBytes } = serializeForPatternCheck(input);
  const normalizedRawText = normalizeHomoglyphs(rawText);
  if (rawBytes > config.maxPayloadBytes) {
    addFlag(
      "structural.oversized-payload",
      `payload size ${rawBytes} bytes exceeds limit ${config.maxPayloadBytes}`,
    );
    // Short-circuit: no point scanning a massive payload further
    return { pass: false, flags, ruleIds };
  }

  // --- JSON depth check ---
  if (typeof input === "object" && input !== null) {
    const depth = measureJsonDepth(input);
    if (depth > config.maxJsonDepth) {
      addFlag(
        "structural.excessive-depth",
        `JSON nesting depth ${depth} exceeds limit ${config.maxJsonDepth}`,
      );
    }
  }

  // --- Collect string leaves for pattern matching ---
  const leaves =
    typeof input === "string"
      ? [{ value: input, fieldName: undefined } as StringLeaf]
      : collectStringLeaves(input);

  for (const leaf of leaves) {
    const { value: original, fieldName } = leaf;

    // Binary content check
    if (hasBinaryContent(original)) {
      addFlag("structural.binary-content", "non-UTF8 or null-byte content in text field");
    }

    // Null byte injection (standalone check for strings that pass hasBinaryContent)
    if (original.includes("\x00")) {
      addFlag("structural.encoding-trick", "null byte injection detected");
    }

    // Base64 in unexpected text field
    if (looksLikeBase64(original, fieldName)) {
      addFlag("structural.encoding-trick", "base64-encoded content in unexpected text field");
    }

    // Apply homoglyph normalization for injection pattern checks
    const normalized = normalizeHomoglyphs(original);
    const homoglyphsFound = normalized !== original;

    // Injection pattern scan (on both original and normalized form)
    for (const [pattern, ruleId] of INJECTION_PATTERNS) {
      if (pattern.test(original) || (homoglyphsFound && pattern.test(normalized))) {
        const description = homoglyphsFound
          ? `injection pattern detected (with homoglyph substitution): ${ruleId}`
          : `injection pattern detected: ${ruleId}`;
        addFlag(ruleId, description);
        if (homoglyphsFound) {
          addFlag("structural.encoding-trick", "homoglyph substitution in injection phrase");
        }
      }
    }

    // Role-switch + capability-grant combo check
    const hasRoleSwitch = ROLE_SWITCH_TRIGGERS.some(
      (re) => re.test(original) || (homoglyphsFound && re.test(normalized)),
    );
    if (hasRoleSwitch) {
      const hasCapGrant = CAPABILITY_GRANTS.some(
        (re) => re.test(rawText) || re.test(normalizedRawText),
      );
      if (hasCapGrant) {
        addFlag(
          "injection.role-switch-capability",
          "role-switch phrase combined with capability-granting phrase",
        );
      }
    }
  }

  return {
    pass: blockingFlagCount === 0,
    flags,
    ruleIds,
  };
}

// ---------------------------------------------------------------------------
// Stage 1B — Schema validation
// ---------------------------------------------------------------------------

/**
 * Allowed top-level fields for transcript raw entries.
 * MUST be updated in the same PR as any change to SessionMemoryRawEntry.
 * Adding a field here without adding it to SessionMemoryRawEntry (and vice
 * versa) is a maintenance error that CI should catch.
 */
export const TRANSCRIPT_ALLOWED_FIELDS = new Set([
  "messageId",
  "timestamp",
  "expiresAt",
  "transcript",
  "body",
  "bodyForAgent",
  "from",
  "to",
  "channelId",
  "conversationId",
  "senderId",
  "senderName",
  "senderUsername",
  "provider",
  "surface",
  "mediaPath",
  "mediaType",
]);

function validateIso8601(value: unknown, fieldName: string): string | null {
  if (typeof value !== "string") return `${fieldName} must be a string`;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return `${fieldName} must be a valid ISO 8601 date`;
  return null;
}

function validateTranscript(input: unknown, lenientExtraFields = false): SchemaValidationResult {
  const violations: string[] = [];
  const ruleIds: string[] = [];
  let blocking = false;

  function addViolation(ruleId: string, description: string, isExtraField = false): void {
    if (!ruleIds.includes(ruleId)) ruleIds.push(ruleId);
    violations.push(description);
    if (!isExtraField || !lenientExtraFields) {
      blocking = true;
    }
  }

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    addViolation("schema.type-mismatch", "transcript entry must be a JSON object");
    return { pass: false, violations, ruleIds };
  }

  const entry = input as Record<string, unknown>;

  // Field allowlist — in strict mode extra fields fail; in lenient mode they flag only
  for (const key of Object.keys(entry)) {
    if (!TRANSCRIPT_ALLOWED_FIELDS.has(key)) {
      addViolation("schema.extra-field", `unexpected field: ${key}`, true);
    }
  }

  // Required field: messageId (non-empty string)
  if (!entry.messageId || typeof entry.messageId !== "string" || !entry.messageId.trim()) {
    addViolation("schema.missing-field", "messageId is required and must be a non-empty string");
  }

  // Required field: timestamp (ISO 8601)
  const tsError = validateIso8601(entry.timestamp, "timestamp");
  if (tsError) addViolation("schema.missing-field", tsError);

  // Required field: transcript (non-empty string)
  if (!entry.transcript || typeof entry.transcript !== "string" || !entry.transcript.trim()) {
    addViolation("schema.missing-field", "transcript is required and must be a non-empty string");
  }

  // Optional string fields — type check only
  const optionalStringFields = [
    "expiresAt",
    "body",
    "bodyForAgent",
    "from",
    "to",
    "channelId",
    "conversationId",
    "senderId",
    "senderName",
    "senderUsername",
    "provider",
    "surface",
    "mediaPath",
    "mediaType",
  ];
  for (const field of optionalStringFields) {
    if (field in entry && entry[field] !== undefined && typeof entry[field] !== "string") {
      addViolation("schema.type-mismatch", `${field} must be a string`);
    }
  }

  return { pass: !blocking, violations, ruleIds };
}

function validateMcpResult(
  input: unknown,
  toolSchema?: ToolOutputSchema,
  lenientExtraFields = false,
  rejectUndeclaredSchema = false,
): SchemaValidationResult {
  const violations: string[] = [];
  const ruleIds: string[] = [];
  let blocking = false;

  function addViolation(ruleId: string, description: string, isExtraField = false): void {
    if (!ruleIds.includes(ruleId)) ruleIds.push(ruleId);
    violations.push(description);
    if (!isExtraField || !lenientExtraFields) {
      blocking = true;
    }
  }

  // No schema declared
  if (!toolSchema) {
    if (rejectUndeclaredSchema) {
      // Admin profile: tools without declared schemas are always rejected
      addViolation(
        "schema.missing-field",
        "MCP result rejected: tool has no declared output schema (admin profile requires declared schemas)",
      );
      return { pass: false, violations, ruleIds };
    }
    // Default: accept JSON object or array only, reject primitives
    if (input === null || (typeof input !== "object" && !Array.isArray(input))) {
      addViolation(
        "schema.type-mismatch",
        "MCP result with no declared schema must be a JSON object or array",
      );
    }
    return { pass: !blocking, violations, ruleIds };
  }

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    addViolation("schema.type-mismatch", "MCP result must be a JSON object");
    return { pass: false, violations, ruleIds };
  }

  const result = input as Record<string, unknown>;

  // Discriminated union validation
  if (toolSchema.discriminant && toolSchema.variants) {
    const discriminantValue = result[toolSchema.discriminant];
    if (discriminantValue === undefined) {
      addViolation(
        "schema.missing-field",
        `discriminant field '${toolSchema.discriminant}' is missing`,
      );
      return { pass: false, violations, ruleIds };
    }
    const variantKey = String(discriminantValue);
    const variant = toolSchema.variants[variantKey];
    if (!variant) {
      addViolation(
        "schema.type-mismatch",
        `unknown discriminant value '${variantKey}' for field '${toolSchema.discriminant}'`,
      );
      return { pass: false, violations, ruleIds };
    }
    // Validate against the selected variant
    const variantFields = new Set(Object.keys(variant));
    for (const key of Object.keys(result)) {
      if (!variantFields.has(key)) {
        addViolation(
          "schema.extra-field",
          `unexpected field '${key}' for variant '${variantKey}'`,
          true,
        );
      }
    }
    for (const [field, expectedType] of Object.entries(variant)) {
      const actual = result[field];
      if (actual === undefined) {
        // The discriminant itself is always required.
        if (field === toolSchema.discriminant) {
          addViolation(
            "schema.missing-field",
            `required field '${field}' missing from variant '${variantKey}'`,
          );
          continue;
        }
        // Optional variant fields (`... | undefined`) may be absent.
        if (isOptionalTypeString(expectedType)) {
          continue;
        }
        addViolation(
          "schema.missing-field",
          `required field '${field}' missing from variant '${variantKey}'`,
        );
        continue;
      }
      if (expectedType !== "any" && !matchesTypeString(actual, expectedType)) {
        addViolation(
          "schema.type-mismatch",
          `field '${field}' expected type '${expectedType}', got '${typeof actual}'`,
        );
      }
    }
    return { pass: !blocking, violations, ruleIds };
  }

  // Single-schema (non-union) validation
  if (toolSchema.fields) {
    const allowedFields = new Set(Object.keys(toolSchema.fields));
    for (const key of Object.keys(result)) {
      if (!allowedFields.has(key)) {
        addViolation("schema.extra-field", `unexpected field '${key}'`, true);
      }
    }
    for (const [field, expectedType] of Object.entries(toolSchema.fields)) {
      const actual = result[field];
      if (actual === undefined) {
        if (isOptionalTypeString(expectedType)) {
          continue;
        }
        addViolation("schema.missing-field", `required field '${field}' missing`);
        continue;
      }
      if (expectedType !== "any" && !matchesTypeString(actual, expectedType)) {
        addViolation(
          "schema.type-mismatch",
          `field '${field}' expected type '${expectedType}', got '${typeof actual}'`,
        );
      }
    }
  }

  return { pass: !blocking, violations, ruleIds };
}

/**
 * Simple type string matcher.
 * Supported type strings: "string", "number", "boolean", "object", "array",
 * "string | null", "string | undefined", "number | null", "any", and "const:<value>".
 */
function isOptionalTypeString(typeStr: string): boolean {
  return typeStr
    .split("|")
    .map((p) => p.trim())
    .some((p) => p === "undefined");
}

function matchesTypeString(value: unknown, typeStr: string): boolean {
  if (typeStr === "any") return true;
  const parts = typeStr.split("|").map((p) => p.trim());
  for (const part of parts) {
    if (part === "undefined" && value === undefined) return true;
    if (part === "null" && value === null) return true;
    if (part === "string" && typeof value === "string") return true;
    if (part === "number" && typeof value === "number") return true;
    if (part === "boolean" && typeof value === "boolean") return true;
    if (part === "object" && value !== null && typeof value === "object" && !Array.isArray(value))
      return true;
    if (part === "array" && Array.isArray(value)) return true;
    if (part.startsWith("const:") && String(value) === part.slice(6)) return true;
  }
  return false;
}

/**
 * Stage 1B: schema validation.
 *
 * Pure function — no I/O, no model calls, no side effects.
 *
 * @param input - The raw payload to validate.
 * @param source - Whether the input is from a transcript or MCP tool call.
 * @param toolSchema - Declared output schema for MCP tools (optional).
 */
export function schemaValidation(
  input: unknown,
  source: "transcript" | "mcp",
  toolSchema?: ToolOutputSchema,
  lenientExtraFields = false,
  rejectUndeclaredSchema = false,
): SchemaValidationResult {
  if (source === "transcript") {
    return validateTranscript(input, lenientExtraFields);
  }
  return validateMcpResult(input, toolSchema, lenientExtraFields, rejectUndeclaredSchema);
}

// ---------------------------------------------------------------------------
// Parallel execution wrapper
// ---------------------------------------------------------------------------

export type PreFilterParams = {
  input: unknown;
  source: "transcript" | "mcp";
  syntacticConfig: SyntacticConfig;
  toolSchema?: ToolOutputSchema;
  /**
   * Schema strictness from the active context profile.
   * When "lenient" (or per-source lenient), extra-field violations flag but do not fail.
   */
  schemaStrictness?:
    | "strict"
    | "lenient"
    | { transcript: "strict" | "lenient"; mcp: "strict" | "lenient" };
  /** When true, MCP results from tools with no declared schema are rejected (admin profile). */
  rejectUndeclaredToolSchemas?: boolean;
};

/**
 * Run Stage 1A and Stage 1B and merge their results.
 *
 * The merged result's `pass` field is true only when both stages pass.
 * We dispatch both stage evaluations first and then await them together.
 */
export async function runPreFilter(params: PreFilterParams): Promise<PreFilterResult> {
  const ss = params.schemaStrictness;
  const lenientTranscript =
    ss === "lenient" || (typeof ss === "object" && ss !== null && ss.transcript === "lenient");
  const lenientMcp =
    ss === "lenient" || (typeof ss === "object" && ss !== null && ss.mcp === "lenient");
  const lenientExtraFields = params.source === "transcript" ? lenientTranscript : lenientMcp;

  const syntacticPromise = Promise.resolve().then(() =>
    syntacticPreFilter(params.input, params.syntacticConfig),
  );
  const schemaPromise = Promise.resolve().then(() =>
    schemaValidation(
      params.input,
      params.source,
      params.toolSchema,
      lenientExtraFields,
      params.rejectUndeclaredToolSchemas ?? false,
    ),
  );
  const [syntactic, schema] = await Promise.all([syntacticPromise, schemaPromise]);

  const allRuleIds = [...new Set([...syntactic.ruleIds, ...schema.ruleIds])];
  const allFlags = [...syntactic.flags, ...schema.violations];

  return {
    syntactic,
    schema,
    pass: syntactic.pass && schema.pass,
    allRuleIds,
    allFlags,
  };
}
