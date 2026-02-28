/**
 * ULS Sanitization & Projection Operator P(z)
 *
 * Deterministic rule-based projection that converts raw state into
 * a shareable public projection, stripping secrets, limiting length,
 * and flagging risks.
 *
 * Future: this module can be replaced by a learned projection model
 * by implementing the same `project()` / `sanitize()` interface.
 */

import type { UlsRiskFlag } from "./types.js";

// ---------------------------------------------------------------------------
// Secret / credential patterns (deterministic redaction)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // API keys & tokens
  { name: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  {
    name: "api_key_param",
    pattern:
      /(?:api[_-]?key|apikey|token|secret|password|passwd|auth)\s*[=:]\s*["']?[A-Za-z0-9\-._~+/]{8,}["']?/gi,
  },
  { name: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "github_token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: "openai_key", pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9-]{20,}/g },
  { name: "slack_token", pattern: /xox[bpas]-[A-Za-z0-9-]+/g },
  { name: "base64_jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Generic high-entropy strings after known key labels
  {
    name: "generic_secret",
    pattern: /(?:SECRET|PRIVATE[_-]?KEY|ACCESS[_-]?TOKEN)\s*[=:]\s*["']?[^\s"']{8,}["']?/gi,
  },
];

// Patterns for sensitive identifiers
const SENSITIVE_ID_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // Full filesystem paths → basename only
  {
    name: "unix_path",
    pattern: /\/(?:home|Users|var|tmp|etc|opt|usr)\/[^\s"']+/g,
    replacement: "<path:$basename>",
  },
  {
    name: "windows_path",
    pattern: /[A-Z]:\\(?:Users|Windows|Program Files)[^\s"']*/gi,
    replacement: "<path:$basename>",
  },
  // IP addresses
  { name: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: "<ip:redacted>" },
  // Hostnames with ports
  { name: "host_port", pattern: /\b[a-zA-Z0-9.-]+:\d{2,5}\b/g, replacement: "<host:redacted>" },
];

// Prompt injection patterns — detect attempts to inject executable instructions
const INJECTION_PATTERNS: RegExp[] = [
  /you (?:are|must|should|will|shall) (?:now |always |immediately )?(?:ignore|forget|disregard|override)/i,
  /(?:system|admin|root|supervisor)\s*(?:prompt|instruction|override|command)/i,
  /\bignore (?:all )?(?:previous |prior |above )?(?:instructions?|rules?|constraints?)/i,
  /(?:new|updated|revised) (?:system )?(?:prompt|instructions?|rules?|persona)/i,
  /\bdo not (?:follow|obey|listen|comply)/i,
  /\breturn (?:the )?(?:system prompt|instructions|password|secret|api.?key)/i,
];

// ---------------------------------------------------------------------------
// Max lengths
// ---------------------------------------------------------------------------

const MAX_FIELD_LENGTH = 4096; // chars per field in p_public
const MAX_SUMMARY_LENGTH = 1024;
const MAX_RAW_LOG_LENGTH = 2048;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run sanitization on raw text, returning cleaned text and risk flags.
 */
export function sanitizeText(raw: string): { cleaned: string; flags: UlsRiskFlag[] } {
  const flags: UlsRiskFlag[] = [];
  let text = raw;

  // 1. Redact secrets
  for (const { pattern } of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(text)) {
      flags.push("credential_leak");
      text = text.replace(new RegExp(pattern.source, pattern.flags), "<redacted:credential>");
    }
  }

  // 2. Redact sensitive identifiers
  for (const { pattern, replacement } of SENSITIVE_ID_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (replacement.includes("$basename")) {
        const parts = match.replace(/\\/g, "/").split("/");
        return replacement.replace("$basename", parts.at(-1) ?? "file");
      }
      return replacement;
    });
  }

  // 3. Detect prompt injection
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      flags.push("injection_suspect");
      break;
    }
  }

  // 4. Check PII (simple heuristic)
  if (/\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/.test(text)) {
    flags.push("pii_detected"); // SSN-like
  }
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) {
    // email — not a flag by itself, but note it
  }

  // 5. Length cap
  if (text.length > MAX_RAW_LOG_LENGTH) {
    flags.push("excessive_length");
    text = text.slice(0, MAX_RAW_LOG_LENGTH) + "… [truncated]";
  }

  return { cleaned: text, flags };
}

/**
 * Sanitize an arbitrary object recursively, cleaning string values.
 * Returns the cleaned object and accumulated risk flags.
 */
export function sanitizeObject(obj: unknown): { cleaned: unknown; flags: UlsRiskFlag[] } {
  const allFlags: UlsRiskFlag[] = [];

  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      const { cleaned, flags } = sanitizeText(value);
      for (const f of flags) {
        if (!allFlags.includes(f)) {
          allFlags.push(f);
        }
      }
      return cleaned;
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  }

  return { cleaned: walk(obj), flags: allFlags };
}

/**
 * Projection operator P(z) → p_public
 *
 * Takes a ULS record and produces the shareable public projection.
 * Rules (v0 — deterministic):
 *   1. Remove z_private entirely
 *   2. Sanitize ut fields (redact secrets, sensitive IDs)
 *   3. Limit raw logs/text to bounded lengths
 *   4. Normalize tool outcomes to structured fields
 *   5. Transform any executable-looking instructions into observations
 */
export function projectPublic(
  ut: Record<string, unknown>,
  modality: string,
): { pPublic: Record<string, unknown>; riskFlags: UlsRiskFlag[] } {
  const { cleaned, flags } = sanitizeObject(ut);
  const sanitized = cleaned as Record<string, unknown>;

  const pPublic: Record<string, unknown> = {};

  // Structured extraction based on modality
  switch (modality) {
    case "tool_result": {
      pPublic.toolName = truncate(stringify(sanitized.toolName ?? "unknown"), 128);
      pPublic.status = sanitized.status ?? sanitized.success ?? "unknown";
      pPublic.summary = truncate(
        stringify(sanitized.summary ?? sanitized.result ?? ""),
        MAX_SUMMARY_LENGTH,
      );
      pPublic.metrics = sanitized.metrics ?? {};
      pPublic.error = sanitized.error ? truncate(stringify(sanitized.error), 512) : undefined;
      break;
    }
    case "user_msg": {
      pPublic.intent = truncate(
        stringify(sanitized.intent ?? sanitized.content ?? ""),
        MAX_SUMMARY_LENGTH,
      );
      pPublic.channel = sanitized.channel;
      break;
    }
    case "plan_step": {
      pPublic.step = truncate(stringify(sanitized.step ?? ""), MAX_SUMMARY_LENGTH);
      pPublic.goal = truncate(stringify(sanitized.goal ?? ""), MAX_SUMMARY_LENGTH);
      pPublic.status = sanitized.status;
      break;
    }
    case "contradiction": {
      pPublic.contradictionType = sanitized.contradictionType;
      pPublic.tensionScore = sanitized.tensionScore;
      pPublic.parties = sanitized.parties;
      pPublic.description = truncate(stringify(sanitized.description ?? ""), MAX_SUMMARY_LENGTH);
      break;
    }
    case "system_event": {
      pPublic.eventType = sanitized.eventType;
      pPublic.summary = truncate(stringify(sanitized.summary ?? ""), MAX_SUMMARY_LENGTH);
      break;
    }
    default: {
      // Generic fallback: take top-level keys, truncate values
      for (const [k, v] of Object.entries(sanitized)) {
        if (typeof v === "string") {
          pPublic[k] = truncate(v, MAX_FIELD_LENGTH);
        } else {
          pPublic[k] = v;
        }
      }
    }
  }

  // Transform anything that looks like instructions into observations
  transformInstructionsToObservations(pPublic);

  return { pPublic, riskFlags: flags };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  return s.slice(0, maxLen) + "… [truncated]";
}

/** Safely convert an unknown value to a string without triggering no-base-to-string. */
function stringify(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (v == null) {
    return "";
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Rewrite any field values that look like executable instructions
 * into passive observation form.
 */
function transformInstructionsToObservations(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "string") {
      continue;
    }
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        // Transform to observation prefix
        obj[key] = `[OBSERVATION — original contained suspected instructions] ${value}`;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exported pattern list for documentation / testing
// ---------------------------------------------------------------------------

export const REDACTION_PATTERNS = SECRET_PATTERNS.map((p) => ({
  name: p.name,
  pattern: p.pattern.source,
}));
