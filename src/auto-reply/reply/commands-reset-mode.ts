import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export type SoftResetParseResult = { matched: false } | { matched: true; tail: string };

export function parseSoftResetCommand(commandBodyNormalized: string): SoftResetParseResult {
  const normalized = normalizeLowercaseStringOrEmpty(commandBodyNormalized);
  const resetMatch = normalized.match(/^\/reset(?:\s|$)/);
  if (!resetMatch) {
    return { matched: false };
  }
  const rest = commandBodyNormalized.slice(resetMatch[0].length).trimStart();
  if (!rest) {
    return { matched: false };
  }
  const restLower = normalizeLowercaseStringOrEmpty(rest);
  if (restLower === "soft") {
    return { matched: true, tail: "" };
  }
  if (restLower.startsWith("soft ")) {
    return { matched: true, tail: rest.slice("soft".length).trimStart() };
  }
  return { matched: false };
}
