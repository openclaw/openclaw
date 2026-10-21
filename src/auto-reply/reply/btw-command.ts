import { normalizeCommandBody, type CommandNormalizeOptions } from "../commands-registry.js";
import { matchSlashCommandToken } from "./commands-slash-parse.js";

const BTW_COMMAND_RE = /^\/btw(?::|\s|$)/i;

export function isBtwRequestText(text?: string, options?: CommandNormalizeOptions): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeCommandBody(text, options).trim();
  return BTW_COMMAND_RE.test(normalized);
}

export function extractBtwQuestion(text?: string): string | null {
  if (!text) {
    return null;
  }
  return matchSlashCommandToken(normalizeCommandBody(text), "/btw");
}
