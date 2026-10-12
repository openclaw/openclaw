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
 * Output fits the audit projector (`^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$`).
 * The output is built from complete encoding tokens only: a token is
 * appended solely when it fits the 128-char bound, so truncation can
 * never cut inside an escape and no suffix stripping is needed. Names
 * longer than the bound stay prefix-distinguishable.
 */
function sanitizeSkillName(value: string): string {
  const trimmed = value.trim().slice(0, SKILL_NAME_MAX_INPUT_CHARS);
  if (!trimmed) {
    return "unknown";
  }
  // A leading `-` would read as a CLI flag, so such output is prefixed to
  // `x-…`. Reserve those 3 chars up front so the bound always holds.
  const firstChar = trimmed.slice(0, 1);
  const needsFlagPrefix = firstChar === "-" || !/[A-Za-z0-9._]/u.test(firstChar);
  const budget = needsFlagPrefix ? ENCODED_SKILL_NAME_MAX_CHARS - 3 : ENCODED_SKILL_NAME_MAX_CHARS;
  let encoded = "";
  const pushToken = (token: string): boolean => {
    if (encoded.length + token.length > budget) {
      return false;
    }
    encoded += token;
    return true;
  };
  for (const ch of trimmed) {
    if (ch === "-") {
      if (!pushToken("--")) {
        break;
      }
    } else if (/[A-Za-z0-9._]/u.test(ch)) {
      if (!pushToken(ch)) {
        break;
      }
    } else {
      let fits = true;
      for (const byte of skillNameByteEncoder.encode(ch)) {
        if (!pushToken(`-${byte.toString(16).padStart(2, "0")}-`)) {
          fits = false;
          break;
        }
      }
      if (!fits) {
        break;
      }
    }
  }
  if (needsFlagPrefix) {
    encoded = `x-${encoded}`;
  }
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
