import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

const LEADING_ROUTE_MARKER_RE = /^(?:assistant|user|commentary)\s+to=\S+/i;
const FUNCTION_TARGET_RE = /\bfunctions\.[a-z0-9_]+\b/i;
const TOOL_JSON_KEY_RE =
  /"(?:command|yieldMs|workdir|path|file_path|oldText|newText|old_string|new_string|sessionId|offset|limit|timeout|background|pty|elevated|security|ask|node)"\s*:/i;

export function hasSuspiciousReplyLeakage(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const hasLeadingRouteMarker = LEADING_ROUTE_MARKER_RE.test(firstLine);
  const hasLeadingSilentWithExtra =
    trimmed.toUpperCase().startsWith(SILENT_REPLY_TOKEN) && !isSilentReplyText(trimmed);
  const hasInternalToolMarker = FUNCTION_TARGET_RE.test(trimmed);
  const hasToolJsonArgs = trimmed.includes("{") && TOOL_JSON_KEY_RE.test(trimmed);

  if (
    hasLeadingSilentWithExtra &&
    (hasLeadingRouteMarker || hasInternalToolMarker || hasToolJsonArgs)
  ) {
    return true;
  }
  if (hasLeadingRouteMarker && (hasInternalToolMarker || hasToolJsonArgs)) {
    return true;
  }
  return false;
}
