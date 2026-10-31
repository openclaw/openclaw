import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type SoftResetParseResult = { matched: false } | { matched: true; tail: string };

export function parseSoftResetCommand(commandBodyNormalized: string): SoftResetParseResult {
  let rest = commandBodyNormalized;
  for (const pattern of [/^\/reset(?:\s|$)/, /^soft(?:\s|$)/]) {
    const match = normalizeLowercaseStringOrEmpty(rest).match(pattern);
    if (!match) {
      return { matched: false };
    }
    rest = rest.slice(match[0].length).trimStart();
  }
  return { matched: true, tail: rest };
}
