import type { SkillTelemetrySource } from "./types.js";

export type RuntimeSkillSelectionMarker = {
  kind: "skill_selection";
  schemaVersion: 1;
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  runId: string | null;
  selectedSkill: string;
  selectionSource: "observed_runtime";
  selectionConfidence: "observed";
  selectionRule: "tool_invocation";
  activation: "command" | "read";
  skillSource: SkillTelemetrySource;
  redaction: "metadata_only";
};

function cleanOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const SKILL_NAME_MAX_INPUT_CHARS = 64;
const ENCODED_SKILL_NAME_MAX_CHARS = 128;
const skillNameByteEncoder = new TextEncoder();

/**
 * Encode a skill name into a distinguishable identity for audit storage.
 * Runtime names like "Daily Brief" stay distinct from "Daily-Brief": every
 * `-` doubles to `--` and every byte outside `[A-Za-z0-9._-]` becomes
 * `-hh-` (lowercase hex), so distinct inputs never share an identity.
 * A leading `-` would read as a CLI flag, so it is prefixed to `x-…`.
 * Output fits the audit projector (`^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$`)
 * and is bounded to 128 chars without cutting a trailing partial escape.
 */
function sanitizeSkillName(value: string): string {
  const trimmed = value.trim().slice(0, SKILL_NAME_MAX_INPUT_CHARS);
  if (!trimmed) {
    return "unknown";
  }
  let encoded = "";
  for (const ch of trimmed) {
    if (ch === "-") {
      encoded += "--";
    } else if (/[A-Za-z0-9._]/u.test(ch)) {
      encoded += ch;
    } else {
      for (const byte of skillNameByteEncoder.encode(ch)) {
        encoded += `-${byte.toString(16).padStart(2, "0")}-`;
      }
    }
  }
  if (encoded.startsWith("-")) {
    encoded = `x-${encoded}`;
  }
  // Truncation can only cut inside a `-hh-` escape; a trailing `-` plus 1-2
  // hex chars is therefore always partial. Complete escapes (`-hh-`) and
  // doubled hyphens (`--`) never match and are preserved.
  encoded = encoded.slice(0, ENCODED_SKILL_NAME_MAX_CHARS).replace(/-[0-9a-f]{1,2}$/u, "");
  if (!encoded || !/^[A-Za-z0-9._]/u.test(encoded)) {
    return "unknown";
  }
  return encoded;
}

export function buildRuntimeSkillSelectionMarker(params: {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  skillName: string;
  skillSource: SkillTelemetrySource;
  activation: "command" | "read";
}): RuntimeSkillSelectionMarker {
  return {
    kind: "skill_selection",
    schemaVersion: 1,
    agentId: cleanOptionalString(params.agentId),
    sessionKey: cleanOptionalString(params.sessionKey),
    sessionId: cleanOptionalString(params.sessionId),
    runId: cleanOptionalString(params.runId),
    selectedSkill: sanitizeSkillName(params.skillName),
    selectionSource: "observed_runtime",
    selectionConfidence: "observed",
    selectionRule: "tool_invocation",
    activation: params.activation,
    skillSource: params.skillSource,
    redaction: "metadata_only",
  };
}
