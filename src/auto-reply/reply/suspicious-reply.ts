import { escapeRegExp } from "../../utils.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

const STRUCTURED_ROUTE_MARKER_LINE_RE =
  /^(?:(?:assistant|user|commentary)\s+to=\S+)(?:\s+(?:(?:assistant|user|commentary)\s+to=\S+|[_\uFF3F]?json))*\s*$/i;
const TOOL_JSON_KEY_RE =
  /"(?:command|yieldMs|workdir|file_path|oldText|newText|old_string|new_string|sessionId|timeout|background|pty|elevated)"\s*:/i;

export type SuspiciousReplyLeakageOptions = {
  silentToken?: string;
};

function stripLeadingSilentToken(text: string, silentToken: string): string {
  const escapedToken = escapeRegExp(silentToken);
  return text.replace(new RegExp(`^\\s*${escapedToken}(?=\\s|$|\\b)`, "i"), "").trimStart();
}

function startsWithSilentToken(text: string, silentToken: string): boolean {
  const escapedToken = escapeRegExp(silentToken);
  return new RegExp(`^\\s*${escapedToken}(?=\\s|$|\\b)`, "i").test(text);
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      return line.trim();
    }
  }
  return "";
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isStructuredRouteMarkerLine(line: string): boolean {
  return STRUCTURED_ROUTE_MARKER_LINE_RE.test(line.trim());
}

function isStructuredToolJsonLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") && TOOL_JSON_KEY_RE.test(trimmed);
}

function isJsonBlockLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "{" ||
    trimmed === "}" ||
    trimmed === "[" ||
    trimmed === "]" ||
    trimmed === "}," ||
    trimmed === "]," ||
    /^"(?:\\.|[^"])+"\s*:/.test(trimmed)
  );
}

function hasStructuredToolJsonBlock(lines: string[]): boolean {
  if (lines.length === 0) {
    return false;
  }
  if (lines.length === 1) {
    return isStructuredToolJsonLine(lines[0]);
  }
  if (lines[0] !== "{") {
    return false;
  }
  if (lines.at(-1) !== "}") {
    return false;
  }
  return lines.every(isJsonBlockLine) && lines.some((line) => TOOL_JSON_KEY_RE.test(line));
}

export function hasSuspiciousReplyLeakage(
  text: string | undefined,
  opts: SuspiciousReplyLeakageOptions = {},
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  const hasLeadingSilentWithExtra =
    startsWithSilentToken(trimmed, silentToken) && !isSilentReplyText(trimmed, silentToken);
  const candidate = hasLeadingSilentWithExtra
    ? stripLeadingSilentToken(trimmed, silentToken)
    : trimmed;
  const lines = nonEmptyLines(candidate);
  const firstLine = firstNonEmptyLine(candidate);
  if (!STRUCTURED_ROUTE_MARKER_LINE_RE.test(firstLine)) {
    return false;
  }
  let routeMarkerLineCount = 0;
  while (
    routeMarkerLineCount < lines.length &&
    isStructuredRouteMarkerLine(lines[routeMarkerLineCount] ?? "")
  ) {
    routeMarkerLineCount += 1;
  }
  if (routeMarkerLineCount === lines.length) {
    return true;
  }
  return hasStructuredToolJsonBlock(lines.slice(routeMarkerLineCount));
}
