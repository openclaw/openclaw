export const DATA_INCIDENT_RE =
  /\b(apy|graphql|internal_server_error|traceId|sentryEventId|vaultv2|wrong values?|stale values?|realtime state)\b/i;

export const EXACT_ARTIFACT_RE =
  /(query\s+[A-Za-z_]\w*|\bvaultV2ByAddress\b|\bvaultByAddress\b|\bsentryEventId\b|\btraceId\b|\b0x[a-fA-F0-9]{8,}\b)/i;

// Access grants only count when they read like a declarative update from a
// human, not when the same words appear in a question.
// Prefix covers sentence boundaries, Slack mentions, and short discourse
// markers like "fyi" / "update" that still read as a human grant statement.
// `\n` matters twice here: it can end the prior clause and it can separate a
// new human grant statement onto the next pasted Slack/log line.
// Examples:
// - "You now have access to Vercel."
// - "<@U123> you now have access to Vercel."
// - "FYI, you now have permissions for Vercel."
const ACCESS_GRANT_DISCOURSE_MARKERS = ["btw", "fyi", "heads up", "update"].join("|");
const ACCESS_GRANT_PREFIX = String.raw`(?:^|[.!?:;\n]\s*|<@[^>\n]+>\s*|(?:${ACCESS_GRANT_DISCOURSE_MARKERS}),?\s+)`;
const ACCESS_GRANT_SPACE = String.raw`[ \t]+`;
const ACCESS_GRANT_TARGET_START = String.raw`[^?\s]`;
const ACCESS_GRANT_TARGET_CONTINUE = String.raw`[^?\n]{0,118}`;
const ACCESS_GRANT_TARGET_END = String.raw`[^?\s]`;
// Access-grant targets stay single-line so question phrasing cannot hide
// behind a newline after "access to"/"permissions for".
const ACCESS_GRANT_SURFACE = String.raw`${ACCESS_GRANT_SPACE}${ACCESS_GRANT_TARGET_START}(?:${ACCESS_GRANT_TARGET_CONTINUE}${ACCESS_GRANT_TARGET_END})?`;
const ACCESS_GRANT_TERMINATOR = String.raw`(?=$|[.!:;\n!])`;
const ACCESS_GRANT_ACCESS_PRESENT = String.raw`you now have access to${ACCESS_GRANT_SURFACE}`;
const ACCESS_GRANT_ACCESS_SIMPLE = String.raw`you have access to${ACCESS_GRANT_SURFACE}`;
const ACCESS_GRANT_PERMISSION_SCOPE = String.raw`(?:${ACCESS_GRANT_SPACE}(?:for|to)${ACCESS_GRANT_SURFACE})?`;
const ACCESS_GRANT_PERMISSIONS_PRESENT = String.raw`you now have permissions${ACCESS_GRANT_PERMISSION_SCOPE}`;
const ACCESS_GRANT_PERMISSIONS_SIMPLE = String.raw`you have permissions${ACCESS_GRANT_PERMISSION_SCOPE}`;
const ACCESS_GRANT_GRANTED_SCOPE = String.raw`(?:${ACCESS_GRANT_SPACE}to${ACCESS_GRANT_SURFACE})?`;
const ACCESS_GRANT_GRANTED = String.raw`access granted${ACCESS_GRANT_GRANTED_SCOPE}`;
const ACCESS_GRANT_CLAUSES = [
  ACCESS_GRANT_ACCESS_PRESENT,
  ACCESS_GRANT_ACCESS_SIMPLE,
  ACCESS_GRANT_PERMISSIONS_PRESENT,
  ACCESS_GRANT_PERMISSIONS_SIMPLE,
  ACCESS_GRANT_GRANTED,
].join("|");
// The body stays lexical so TS + grep mirrors share one phrase list while
// still rejecting question phrasing like "You have access to Vercel?".
const ACCESS_GRANT_BODY = String.raw`(?:${ACCESS_GRANT_CLAUSES})${ACCESS_GRANT_TERMINATOR}`;
const ACCESS_GRANT_STATEMENT = String.raw`${ACCESS_GRANT_PREFIX}${ACCESS_GRANT_BODY}`;
const HUMAN_CORRECTION_PHRASES = String.raw`\b(this is wrong|that is wrong|you(?:'re| are) wrong|(?:this|that) is not (?:the issue|correct|right|accurate)\b|does not look like\b|not a ui problem\b|(?:the\s+)?actual issue is\b|(?:the\s+)?main issue is\b|the bug is\b|the issue is actually\b|the issue is\b[^.!?\n]{0,80}\b(?:instead of|rather than)\b|miscommunication\b|current lead is\b|we confirmed\b|this is connected\b|my only explanation\b|not the issue\b|old lead is stale\b|previous guess was stale\b|outdated theory\b)`;

// Intentionally biased toward explicit human scope corrections that should
// supersede an earlier bot theory in incident and bug-report threads.
export const HUMAN_CORRECTION_RE = new RegExp(
  `${HUMAN_CORRECTION_PHRASES}|${ACCESS_GRANT_STATEMENT}`,
  "i",
);
// Keep correction scans aligned with the runtime guardrail signal budget so
// prompt/transcript snippets and regex matches drop context at the same edge.
const HUMAN_CORRECTION_MAX_CHARS = 4_000;
export const ACCESS_GRANT_RE = new RegExp(ACCESS_GRANT_STATEMENT, "i");

export function matchesHumanCorrection(text: string): boolean {
  const bounded = text.slice(0, HUMAN_CORRECTION_MAX_CHARS).trim();
  if (!bounded) {
    return false;
  }
  return HUMAN_CORRECTION_RE.test(bounded);
}

export function matchesAccessGrant(text: string): boolean {
  const bounded = text.slice(0, HUMAN_CORRECTION_MAX_CHARS).trim();
  if (!bounded) {
    return false;
  }
  return ACCESS_GRANT_RE.test(bounded);
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
