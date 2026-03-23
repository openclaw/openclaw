export const SLACK_INCIDENT_HEADER_RE = /^(?:\*Incident:\*|_Incident:_)/;

const SLACK_ROUTING_PREFIX_RE = /^\[\[[^\]\n]+\]\]\s*/;
const SLACK_MENTION_PREFIX_RE =
  /^(?:<@[A-Z0-9]+>|<!subteam\^[^>\n]+>|<!(?:channel|everyone|here)>|<#(?:[A-Z0-9]+)(?:\|[^>\n]+)?>)\s*/i;

function stripOneSlackIncidentAllowedPrefix(line: string): string {
  if (SLACK_ROUTING_PREFIX_RE.test(line)) {
    return line.replace(SLACK_ROUTING_PREFIX_RE, "");
  }
  if (SLACK_MENTION_PREFIX_RE.test(line)) {
    return line.replace(SLACK_MENTION_PREFIX_RE, "");
  }
  return line;
}

export function stripSlackIncidentAllowedPrefixes(line: string): string {
  let remaining = line.trim();
  while (remaining) {
    const stripped = stripOneSlackIncidentAllowedPrefix(remaining);
    if (stripped === remaining) {
      break;
    }
    remaining = stripped.trimStart();
  }
  return remaining;
}

export function findSlackIncidentHeaderLineIndex(text: string): number {
  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (SLACK_INCIDENT_HEADER_RE.test(line)) {
      return index;
    }
    const withoutAllowedPrefixes = stripSlackIncidentAllowedPrefixes(line);
    if (!withoutAllowedPrefixes) {
      continue;
    }
    if (SLACK_INCIDENT_HEADER_RE.test(withoutAllowedPrefixes)) {
      return index;
    }
    return -1;
  }
  return -1;
}

export function startsWithSlackIncidentHeaderAfterAllowedPrefixes(text: string): boolean {
  return findSlackIncidentHeaderLineIndex(text) >= 0;
}
