import { collapseInlineHorizontalWhitespace } from "./reply-inline-whitespace.js";

const INLINE_SIMPLE_COMMAND_ALIASES = new Map<string, string>([
  ["/help", "/help"],
  ["/commands", "/commands"],
  ["/whoami", "/whoami"],
  ["/id", "/whoami"],
]);
const INLINE_SIMPLE_COMMAND_RE = /(?:^|\s)\/(help|commands|whoami|id)(?=$|\s|:)/i;

const INLINE_STATUS_RE = /(?:^|\s)\/status(?=$|\s|:)(?:\s*:\s*)?/gi;

function isInlineModelStatusQuery(body: string): boolean {
  const normalized = collapseInlineHorizontalWhitespace(body).trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  // Keep this conservative: only route direct "what model are you"
  // style prompts to /status. Avoid hijacking unrelated "which model"
  // product questions.
  if (/\b(?:what|which)\s+model\s+are\s+(?:you|u|yuo|yoy|yu)\b/.test(normalized)) {
    return true;
  }
  const asksModel = normalized.includes("what model") || normalized.includes("which model");
  if (!asksModel) {
    return false;
  }
  return (
    /\b(?:you|u)\b/.test(normalized) ||
    normalized.includes("running") ||
    normalized.includes("using") ||
    normalized.includes("is that")
  );
}

export function extractInlineSimpleCommand(body?: string): {
  command: string;
  cleaned: string;
} | null {
  if (!body) {
    return null;
  }
  if (isInlineModelStatusQuery(body)) {
    return { command: "/status", cleaned: "" };
  }
  const match = body.match(INLINE_SIMPLE_COMMAND_RE);
  if (!match || match.index === undefined) {
    return null;
  }
  const alias = `/${match[1].toLowerCase()}`;
  const command = INLINE_SIMPLE_COMMAND_ALIASES.get(alias);
  if (!command) {
    return null;
  }
  const cleaned = collapseInlineHorizontalWhitespace(body.replace(match[0], " ")).trim();
  return { command, cleaned };
}

export function stripInlineStatus(body: string): {
  cleaned: string;
  didStrip: boolean;
} {
  const trimmed = body.trim();
  if (!trimmed) {
    return { cleaned: "", didStrip: false };
  }
  // Use [^\S\n]+ instead of \s+ to only collapse horizontal whitespace,
  // preserving newlines so multi-line messages keep their paragraph structure.
  const cleaned = collapseInlineHorizontalWhitespace(trimmed.replace(INLINE_STATUS_RE, " ")).trim();
  return { cleaned, didStrip: cleaned !== trimmed };
}
