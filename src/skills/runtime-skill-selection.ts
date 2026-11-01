import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
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
 * appended solely when it fits the bounded prefix budget, so truncation can
 * never cut inside an escape. Truncated names receive a digest suffix so
 * distinct names with the same encoded prefix remain distinct.
 */
function sanitizeSkillName(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "unknown";
  }
  const trimmed = normalized.slice(0, SKILL_NAME_MAX_INPUT_CHARS);
  const digestSuffix = `-${sha256Hex(normalized).slice(0, 10)}`;
  // A leading `-` would read as a CLI flag, so such output is prefixed to
  // `x-…`. Reserve the prefix and digest space up front so the bound always
  // holds when the encoded name is truncated.
  const firstChar = trimmed.slice(0, 1);
  const needsFlagPrefix = firstChar === "-" || !/[A-Za-z0-9._]/u.test(firstChar);
  const prefixLength = needsFlagPrefix ? 3 : 0;
  const budget = ENCODED_SKILL_NAME_MAX_CHARS - prefixLength - digestSuffix.length;
  let encoded = "";
  let truncated = false;
  const pushToken = (token: string): boolean => {
    if (encoded.length + token.length > budget) {
      truncated = true;
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
  return truncated ? `${encoded}${digestSuffix}` : encoded;
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
