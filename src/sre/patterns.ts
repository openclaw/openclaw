export const DATA_INCIDENT_RE =
  /\b(apy|graphql|internal_server_error|traceId|sentryEventId|vaultv2|wrong values?|stale values?|realtime state)\b/i;

export const EXACT_ARTIFACT_RE =
  /(query\s+[A-Za-z_]\w*|\bvaultV2ByAddress\b|\bvaultByAddress\b|\bsentryEventId\b|\btraceId\b|\b0x[a-fA-F0-9]{8,}\b)/i;

// Intentionally biased toward explicit human scope corrections that should
// supersede an earlier bot theory in incident and bug-report threads.
export const HUMAN_CORRECTION_RE =
  /\b(this is wrong|that is wrong|you(?:'re| are) wrong|(?:this|that) is not (?:the issue|correct|right|accurate)\b|does not look like\b|not a ui problem\b|(?:the\s+)?actual issue is\b|(?:the\s+)?main issue is\b|the bug is\b|the issue is actually\b|the issue is\b[^.!?\n]{0,80}\b(?:instead of|rather than)\b|miscommunication\b|current lead is\b|we confirmed\b|this is connected\b|my only explanation\b|not the issue\b|old lead is stale\b|previous guess was stale\b|outdated theory\b)\b/i;
const HUMAN_CORRECTION_MAX_CHARS = 4_000;

export function matchesHumanCorrection(text: string): boolean {
  const bounded = text.slice(0, HUMAN_CORRECTION_MAX_CHARS).trim();
  if (!bounded) {
    return false;
  }
  return HUMAN_CORRECTION_RE.test(bounded);
}

export function extractResolverFamily(
  text: string,
): "vaultV2ByAddress" | "vaultByAddress" | undefined {
  if (/\bvaultV2ByAddress\b/.test(text)) {
    return "vaultV2ByAddress";
  }
  if (/\bvaultByAddress\b/.test(text)) {
    return "vaultByAddress";
  }
  return undefined;
}

export function extractInlineJsonTextValue(line: string): string | undefined {
  const match = /"text":"((?:[^"\\]|\\.)*)"/.exec(line);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, '"');
  }
}
