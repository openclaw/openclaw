import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

const STRUCTURED_ROUTE_MARKER_LINE_RE =
  /^(?:(?:assistant|user|commentary)\s+to=\S+)(?:\s+(?:(?:assistant|user|commentary)\s+to=\S+|[_\uFF3F]?json))*\s*$/i;
const TOOL_JSON_KEY_RE =
  /"(?:command|yieldMs|workdir|file_path|oldText|newText|old_string|new_string|sessionId|timeout|background|pty|elevated)"\s*:/i;

function stripLeadingSilentToken(text: string): string {
  return text.replace(new RegExp(`^\\s*${SILENT_REPLY_TOKEN}\\b`, "i"), "").trimStart();
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      return line.trim();
    }
  }
  return "";
}

function hasStructuredToolJsonLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("{") && TOOL_JSON_KEY_RE.test(trimmed);
  });
}

export function hasSuspiciousReplyLeakage(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }

  const hasLeadingSilentWithExtra =
    trimmed.toUpperCase().startsWith(SILENT_REPLY_TOKEN) && !isSilentReplyText(trimmed);
  const candidate = hasLeadingSilentWithExtra ? stripLeadingSilentToken(trimmed) : trimmed;
  const hasStructuredRouteMarkerLead = STRUCTURED_ROUTE_MARKER_LINE_RE.test(
    firstNonEmptyLine(candidate),
  );
  const hasToolJsonArgs = candidate.includes("{") && hasStructuredToolJsonLine(candidate);

  if (hasLeadingSilentWithExtra && (hasStructuredRouteMarkerLead || hasToolJsonArgs)) {
    return true;
  }
  if (hasStructuredRouteMarkerLead && hasToolJsonArgs) {
    return true;
  }
  return false;
}
