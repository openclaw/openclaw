/**
 * Tier 1 structural pre-filter for MCP tool results.
 *
 * Runs before the sanitization sub-agent (Tier 2). Catches structurally obvious
 * threats at sub-millisecond cost with no LLM invocation.
 *
 * Design principle: err toward false negatives, not false positives.
 * Anything requiring judgment about intent, scope, or context is a Tier 2 concern.
 *
 * Categories 1-7 implemented. Category 8 (temporal/behavioral signals) deferred —
 * see TEMPORAL placeholder at the bottom of this file.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Tier1CheckResult = {
  /** True if any blocking pattern matched. The sub-agent must not be invoked. */
  blocked: boolean;
  /** Descriptions of blocking patterns matched (for flags in the MCP child result). */
  blockFlags: string[];
  /** Flag-only patterns matched (passed via tier1-annotations.json to Tier 2). */
  annotationFlags: string[];
  /** Pattern IDs that matched (both block and flag). */
  patternsMatched: string[];
  /** Brief description for audit contextNote. */
  contextNote: string;
};

export type Tier1Params = {
  rawResult: unknown;
  /** SIZE-001 threshold in bytes (default: 512 * 1024). */
  sizeThresholdBytes?: number;
  /** SIZE-002 per-field threshold in bytes (default: 256 * 1024). */
  fieldSizeThresholdBytes?: number;
};

// ---------------------------------------------------------------------------
// Internal check result accumulator
// ---------------------------------------------------------------------------

type CheckAccumulator = {
  blockFlags: string[];
  annotationFlags: string[];
  patternsMatched: string[];
};

function addBlock(acc: CheckAccumulator, patternId: string, description: string): void {
  acc.blockFlags.push(description);
  acc.patternsMatched.push(patternId);
}

function addAnnotation(acc: CheckAccumulator, patternId: string, description: string): void {
  acc.annotationFlags.push(description);
  acc.patternsMatched.push(patternId);
}

// ---------------------------------------------------------------------------
// Helpers — object traversal
// ---------------------------------------------------------------------------

function collectStringValues(
  obj: unknown,
  out: string[] = [],
  visited = new WeakSet<object>(),
): string[] {
  if (typeof obj === "string") {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    if (visited.has(obj)) return out;
    visited.add(obj);
    for (const item of obj) {
      collectStringValues(item, out, visited);
    }
  } else if (obj !== null && typeof obj === "object") {
    if (visited.has(obj)) return out;
    visited.add(obj);
    for (const v of Object.values(obj)) {
      collectStringValues(v, out, visited);
    }
  }
  return out;
}

function collectFieldNames(
  obj: unknown,
  out: string[] = [],
  visited = new WeakSet<object>(),
): string[] {
  if (Array.isArray(obj)) {
    if (visited.has(obj)) return out;
    visited.add(obj);
    for (const item of obj) {
      collectFieldNames(item, out, visited);
    }
  } else if (obj !== null && typeof obj === "object") {
    if (visited.has(obj)) return out;
    visited.add(obj);
    for (const key of Object.keys(obj)) {
      out.push(key);
      collectFieldNames((obj as Record<string, unknown>)[key], out, visited);
    }
  }
  return out;
}

function measureNestingDepth(obj: unknown, depth = 0): number {
  if (depth > 20) {
    return depth;
  }
  if (obj !== null && typeof obj === "object") {
    const children = Array.isArray(obj) ? obj : Object.values(obj);
    if (children.length === 0) {
      return depth;
    }
    return Math.max(...children.map((child) => measureNestingDepth(child, depth + 1)));
  }
  return depth;
}

function allDataFieldsEmpty(obj: unknown, visited = new WeakSet<object>()): boolean {
  if (obj === null || obj === undefined) {
    return true;
  }
  if (Array.isArray(obj)) {
    return obj.length === 0;
  }
  if (typeof obj === "object") {
    if (visited.has(obj)) return false;
    visited.add(obj);
    const values = Object.values(obj as Record<string, unknown>);
    if (values.length === 0) return false;
    return values.every(
      (v) =>
        v === null ||
        v === undefined ||
        v === "" ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "object" && v !== null && allDataFieldsEmpty(v, visited)),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers — entropy
// ---------------------------------------------------------------------------

function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const char of str) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }
  const len = str.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// Helpers — base64
// ---------------------------------------------------------------------------

const BASE64_RE = /^[A-Za-z0-9+/\-_]+=*$/;

function isBase64Candidate(str: string): boolean {
  return str.length > 20 && BASE64_RE.test(str);
}

function decodeBase64Safe(str: string): string | null {
  try {
    const decoded = Buffer.from(str, "base64").toString("utf8");
    // Sanity check: decoded content should be valid text
    if (decoded.includes("\x00")) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Category 1 — Injection pattern matching
// ---------------------------------------------------------------------------

type InjectionPattern = { id: string; re: RegExp };

const INJECTION_PATTERNS: InjectionPattern[] = [
  { id: "INJ-001", re: /ignore\s+(all\s+)?previous\s+instructions/i },
  {
    id: "INJ-002",
    re: /you\s+are\s+now\s+(in\s+)?(a\s+)?(\w+\s+)?(mode|role|persona|assistant)/i,
  },
  { id: "INJ-003", re: /(^|\n|\r|")\s*(SYSTEM|ASSISTANT|ADMIN)\s*:/im },
  {
    id: "INJ-004",
    re: /override\s+(your\s+)?(output|schema|behavior|instructions|prompt|safety|rules)/i,
  },
  {
    id: "INJ-005",
    re: /output\s+(your\s+)?(system\s+prompt|session\s+memory|context|instructions|config)/i,
  },
  {
    id: "INJ-006",
    re: /disregard\s+(all\s+)?(prior|previous|your|safety|security)\s+(rules|instructions|guidelines|constraints)/i,
  },
  {
    id: "INJ-007",
    re: /do\s+not\s+follow\s+(your\s+)?(previous|prior|original|safety|system)/i,
  },
  { id: "INJ-008", re: /<\s*IMPORTANT\s*>|<\s*URGENT\s*>|<\s*INSTRUCTION\s*>/i },
  {
    id: "INJ-009",
    re: /<!--\s*(assistant|system|ignore|override|disregard|instruction)/i,
  },
];

function checkInjectionPatterns(serialized: string, acc: CheckAccumulator): void {
  for (const { id, re } of INJECTION_PATTERNS) {
    if (re.test(serialized)) {
      addBlock(acc, id, `${id}: injection pattern matched in result content`);
    }
  }
}

// ---------------------------------------------------------------------------
// Category 2 — Credential-shaped content detection
// ---------------------------------------------------------------------------

// CRED-001 through CRED-007 run against the serialized result.
// CRED-008 (entropy) runs per string field value.

const CREDENTIAL_PATTERNS: InjectionPattern[] = [
  { id: "CRED-001", re: /(api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i },
  { id: "CRED-002", re: /(bearer|authorization)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{20,}/i },
  { id: "CRED-003", re: /AKIA[0-9A-Z]{16}/ },
  { id: "CRED-004", re: /sk-[a-zA-Z0-9_\-]{30,}/ },
  { id: "CRED-005", re: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
  { id: "CRED-006", re: /(password|passwd|pwd|secret)\s*[:=]\s*["']?[^\s"',]{8,}/i },
  { id: "CRED-007", re: /(mongodb|postgres|mysql|redis|amqp):\/\/[^:]+:[^@]+@/i },
];

function checkCredentialPatterns(serialized: string, acc: CheckAccumulator): void {
  for (const { id, re } of CREDENTIAL_PATTERNS) {
    if (re.test(serialized)) {
      addBlock(acc, id, `${id}: credential-shaped content detected in result`);
    }
  }
}

// CRED-008: entropy analysis on short-to-medium string field values.
// Applied only to values > 20 chars and < 1KB (length heuristic excludes file
// contents and code snippets). Tool-type awareness is a future refinement.
const CRED008_MIN_LEN = 20;
const CRED008_MAX_LEN = 1024;
const CRED008_ENTROPY_THRESHOLD = 4.5;

function checkEntropyCredentials(values: string[], acc: CheckAccumulator): void {
  for (const v of values) {
    if (v.length > CRED008_MIN_LEN && v.length < CRED008_MAX_LEN) {
      // Skip entropy check if value contains non-Latin characters —
      // high entropy is expected and benign for CJK, Arabic, Devanagari, etc.
      if (/[^\u0000-\u024F]/.test(v)) continue;
      if (shannonEntropy(v) > CRED008_ENTROPY_THRESHOLD) {
        addBlock(acc, "CRED-008", "CRED-008: high-entropy string detected in result field value");
        return; // one flag is sufficient
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Category 3 — Malformation detection
// ---------------------------------------------------------------------------

const MALFORMATION_PATTERNS: InjectionPattern[] = [
  { id: "MAL-001", re: /<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i },
  {
    id: "MAL-002",
    re: /\b(502|503|504)\s+(Bad\s+Gateway|Service\s+Unavailable|Gateway\s+Timeout)/i,
  },
  {
    id: "MAL-003",
    re: /(Traceback \(most recent call last\)|Exception in thread|at\s+[\w.]+\([\w.]+:\d+\)|panic:|FATAL ERROR)/i,
  },
];

function checkMalformationPatterns(
  serialized: string,
  rawResult: unknown,
  acc: CheckAccumulator,
): void {
  for (const { id, re } of MALFORMATION_PATTERNS) {
    if (re.test(serialized)) {
      addBlock(acc, id, `${id}: malformed result content detected`);
    }
  }
  // MAL-004: all data fields empty with no error field set
  if (rawResult !== null && typeof rawResult === "object" && !Array.isArray(rawResult)) {
    const obj = rawResult as Record<string, unknown>;
    const hasErrorField =
      "error" in obj && obj["error"] !== null && obj["error"] !== undefined && obj["error"] !== "";
    if (!hasErrorField && allDataFieldsEmpty(rawResult)) {
      addBlock(acc, "MAL-004", "MAL-004: all result fields are empty with no error reported");
    }
  }
}

// ---------------------------------------------------------------------------
// Category 4 — Payload size
// ---------------------------------------------------------------------------

const DEFAULT_SIZE_THRESHOLD_BYTES = 512 * 1024;
const DEFAULT_FIELD_SIZE_THRESHOLD_BYTES = 256 * 1024;

function checkPayloadSize(
  serialized: string,
  values: string[],
  sizeThreshold: number,
  fieldSizeThreshold: number,
  acc: CheckAccumulator,
): void {
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  if (totalBytes > sizeThreshold) {
    addBlock(
      acc,
      "SIZE-001",
      `SIZE-001: result payload exceeds size limit (${totalBytes} bytes > ${sizeThreshold} bytes)`,
    );
  }
  for (const v of values) {
    const fieldBytes = Buffer.byteLength(v, "utf8");
    if (fieldBytes > fieldSizeThreshold) {
      addBlock(
        acc,
        "SIZE-002",
        `SIZE-002: single field value exceeds size limit (${fieldBytes} bytes > ${fieldSizeThreshold} bytes)`,
      );
      return; // one flag is sufficient
    }
  }
}

// ---------------------------------------------------------------------------
// Category 5 — Content type mismatch
// ---------------------------------------------------------------------------

// Executable file format magic bytes as strings (as they would appear in field values).
const EXECUTABLE_SIGNATURES_RE = /^(MZ|ELF|\x7fELF|PK\x03\x04|%PDF)/;

function checkContentTypes(values: string[], acc: CheckAccumulator): void {
  for (const v of values) {
    // TYPE-001: null bytes indicate binary content in a text field
    if (v.includes("\x00")) {
      addBlock(acc, "TYPE-001", "TYPE-001: null byte detected in string field value");
      break;
    }
  }
  for (const v of values) {
    // TYPE-002: executable/archive format signatures
    if (EXECUTABLE_SIGNATURES_RE.test(v)) {
      addBlock(acc, "TYPE-002", "TYPE-002: executable or archive format signature in field value");
      break;
    }
  }
  for (const v of values) {
    // TYPE-003: large base64-encoded blobs (>= 500 chars, pure base64)
    if (v.length >= 500 && /^[A-Za-z0-9+/]{500,}={0,2}$/.test(v)) {
      addBlock(acc, "TYPE-003", "TYPE-003: large base64-encoded payload in field value");
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Category 6 — Encoding and obfuscation detection
// ---------------------------------------------------------------------------

const ENC002_RE = /(?:\\u[0-9a-fA-F]{4}){4,}/;
const ENC003_RE = /(?:\\x[0-9a-fA-F]{2}){8,}/;
const ENC004_RE = /(?:&#x?[0-9a-fA-F]+;){4,}/;

// Simplified Unicode script block detection for ENC-005.
// Checks for characters from 3+ broad Unicode ranges within a single value.
function detectMixedScripts(str: string): boolean {
  const ranges = [
    /[\u0041-\u007A]/, // Basic Latin (A-z)
    /[\u0400-\u04FF]/, // Cyrillic
    /[\u4E00-\u9FFF]/, // CJK Unified Ideographs
    /[\u0600-\u06FF]/, // Arabic
    /[\u0900-\u097F]/, // Devanagari
    /[\u3040-\u30FF]/, // Hiragana/Katakana
  ];
  const matchCount = ranges.filter((re) => re.test(str)).length;
  return matchCount >= 3;
}

// ENC-001: decode base64 fragments (< 500 chars, to avoid overlap with TYPE-003)
// and run injection patterns against the decoded content.
function checkBase64EncodedInjection(values: string[], acc: CheckAccumulator): void {
  for (const v of values) {
    if (v.length > 20 && v.length < 500 && isBase64Candidate(v)) {
      const decoded = decodeBase64Safe(v);
      if (decoded) {
        for (const { id, re } of INJECTION_PATTERNS) {
          if (re.test(decoded)) {
            addBlock(
              acc,
              "ENC-001",
              `ENC-001: base64-decoded content matched injection pattern ${id}`,
            );
            return;
          }
        }
      }
    }
  }
}

function checkEncodingPatterns(serialized: string, values: string[], acc: CheckAccumulator): void {
  // ENC-001 applied per string value
  checkBase64EncodedInjection(values, acc);

  // ENC-002 through ENC-005: flag-only (pass to Tier 2 as annotations)
  if (ENC002_RE.test(serialized)) {
    addAnnotation(acc, "ENC-002", "ENC-002: 4+ consecutive Unicode escapes detected in result");
  }
  if (ENC003_RE.test(serialized)) {
    addAnnotation(acc, "ENC-003", "ENC-003: 8+ consecutive hex escapes detected in result");
  }
  if (ENC004_RE.test(serialized)) {
    addAnnotation(acc, "ENC-004", "ENC-004: 4+ consecutive HTML entities detected in result");
  }
  for (const v of values) {
    if (v.length > 20 && detectMixedScripts(v)) {
      addAnnotation(acc, "ENC-005", "ENC-005: mixed Unicode script blocks detected in field value");
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Category 7 — Structural topology checks
// ---------------------------------------------------------------------------

const STRUCT001_MAX_DEPTH = 10;
const STRUCT002_MAX_FIELDS = 200;

function checkStructuralTopology(rawResult: unknown, acc: CheckAccumulator): void {
  // STRUCT-001: excessive nesting depth
  const depth = measureNestingDepth(rawResult);
  if (depth > STRUCT001_MAX_DEPTH) {
    addBlock(
      acc,
      "STRUCT-001",
      `STRUCT-001: result nesting depth (${depth}) exceeds limit (${STRUCT001_MAX_DEPTH})`,
    );
  }

  // STRUCT-002: field count at top level only (arrays have no named fields)
  const fieldCount =
    rawResult !== null && typeof rawResult === "object" && !Array.isArray(rawResult)
      ? Object.keys(rawResult).length
      : 0;
  if (fieldCount > STRUCT002_MAX_FIELDS) {
    addBlock(
      acc,
      "STRUCT-002",
      `STRUCT-002: result field count (${fieldCount}) exceeds limit (${STRUCT002_MAX_FIELDS})`,
    );
  }

  // STRUCT-003: apply injection patterns against field names
  const fieldNames = collectFieldNames(rawResult);
  for (const fieldName of fieldNames) {
    for (const { id, re } of INJECTION_PATTERNS) {
      if (re.test(fieldName)) {
        addBlock(
          acc,
          "STRUCT-003",
          `STRUCT-003: injection pattern ${id} matched in field name "${fieldName}"`,
        );
        return;
      }
    }
  }

  // STRUCT-004 intentionally deferred:
  // duplicate JSON keys are lost before this check runs because `rawResult` is
  // already parsed into a JS object (last-write-wins). Detecting duplicates
  // requires scanning raw JSON text before parse.
}

// ---------------------------------------------------------------------------
// Category 8 — Temporal and behavioral signals (deferred)
// ---------------------------------------------------------------------------
//
// TEMPORAL-001 (result content drift), TEMPORAL-002 (injection attempt frequency),
// and TEMPORAL-003 (result size spike) require a stateful per-server sliding window.
//
// Seam: wire temporal checks here when implemented. The check should receive the
// server identifier and a mutable temporal state store, returning flags/annotations
// in the same format as other categories.
//
// function checkTemporalSignals(server: string, result: unknown, acc: CheckAccumulator): void { ... }

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function runTier1PreFilter(params: Tier1Params): Tier1CheckResult {
  const acc: CheckAccumulator = {
    blockFlags: [],
    annotationFlags: [],
    patternsMatched: [],
  };

  const sizeThreshold = params.sizeThresholdBytes ?? DEFAULT_SIZE_THRESHOLD_BYTES;
  const fieldSizeThreshold = params.fieldSizeThresholdBytes ?? DEFAULT_FIELD_SIZE_THRESHOLD_BYTES;

  // Serialize once — used for string-level pattern matching and size checks.
  let serialized: string;
  try {
    serialized = JSON.stringify(params.rawResult) ?? "";
  } catch {
    serialized = "";
  }

  const stringValues = collectStringValues(params.rawResult);

  // Run all categories in order.
  checkInjectionPatterns(serialized, acc);
  checkCredentialPatterns(serialized, acc);
  checkEntropyCredentials(stringValues, acc);
  checkMalformationPatterns(serialized, params.rawResult, acc);
  checkPayloadSize(serialized, stringValues, sizeThreshold, fieldSizeThreshold, acc);
  checkContentTypes(stringValues, acc);
  checkEncodingPatterns(serialized, stringValues, acc);
  checkStructuralTopology(params.rawResult, acc);

  const blocked = acc.blockFlags.length > 0;
  const contextNote = blocked
    ? `Tier 1 blocked: ${acc.patternsMatched.filter((id) => acc.blockFlags.some((f) => f.startsWith(id))).join(", ")}`
    : acc.annotationFlags.length > 0
      ? `Tier 1 passed with annotations: ${acc.patternsMatched.join(", ")}`
      : "Tier 1 passed clean";

  return {
    blocked,
    blockFlags: acc.blockFlags,
    annotationFlags: acc.annotationFlags,
    patternsMatched: acc.patternsMatched,
    contextNote,
  };
}
