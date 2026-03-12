import type { OpenClawConfig } from "../config/types.js";
import {
  type CommandNormalizeOptions,
  listChatCommands,
  listChatCommandsForConfig,
  normalizeCommandBody,
} from "./commands-registry.js";
import { isAbortTrigger } from "./reply/abort.js";
import { normalizeThinkLevel } from "./thinking.js";

const THINK_COMMAND_ALIASES = new Set(["think", "thinking", "t"]);

function parseOneShotThinkMessage(
  text?: string,
  options?: CommandNormalizeOptions,
): { level: string; body: string } | null {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const match = trimmed.match(/^\/([^\s@:]+)(?:@([^\s:]+))?([\s\S]*)$/);
  if (!match) {
    return null;
  }
  const [, command, botUsername, remainder] = match;
  if (!THINK_COMMAND_ALIASES.has(command.toLowerCase())) {
    return null;
  }
  if (botUsername) {
    const normalizedBotUsername = options?.botUsername?.trim().toLowerCase();
    if (!normalizedBotUsername || botUsername.toLowerCase() !== normalizedBotUsername) {
      return null;
    }
  }

  // Keep the full remainder instead of normalizeCommandBody(), which truncates at the first
  // newline and would misclassify multiline one-shot bodies as plain control commands.
  const rest = remainder.trimStart();
  const withoutColon = rest.startsWith(":") ? rest.slice(1).trimStart() : rest;
  if (!withoutColon) {
    return null;
  }

  const levelMatch = withoutColon.match(/^([A-Za-z-]+)([\s\S]*)$/);
  if (!levelMatch) {
    return null;
  }
  const [, rawLevel, body] = levelMatch;
  if (!normalizeThinkLevel(rawLevel)) {
    return null;
  }
  if (!body.trim()) {
    return null;
  }
  return { level: rawLevel, body };
}

export function hasControlCommand(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalizedBody = normalizeCommandBody(trimmed, options);
  if (!normalizedBody) {
    return false;
  }
  const lowered = normalizedBody.toLowerCase();
  const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
  for (const command of commands) {
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (lowered === normalized) {
        return true;
      }
      if (command.acceptsArgs && lowered.startsWith(normalized)) {
        const nextChar = normalizedBody.charAt(normalized.length);
        if (nextChar && /\s/.test(nextChar)) {
          // One-shot think: /think <level> <body> is not a control command.
          if (isOneShotThinkMessage(trimmed, options)) {
            return false;
          }
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Detect one-shot think messages: `/think <level> <body>`.
 * These should NOT be treated as control commands, they carry a message body
 * that needs AI processing, with the think level applied for that single message only.
 */
export function isOneShotThinkMessage(text?: string, options?: CommandNormalizeOptions): boolean {
  return parseOneShotThinkMessage(text, options) !== null;
}

export function isControlCommandMessage(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (hasControlCommand(trimmed, cfg, options)) {
    return true;
  }
  const normalized = normalizeCommandBody(trimmed, options).trim().toLowerCase();
  return isAbortTrigger(normalized);
}

/**
 * Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
 * can decide whether to compute CommandAuthorized for a message.
 *
 * This intentionally errs on the side of false positives; CommandAuthorized only gates
 * command/directive execution, not normal chat replies.
 */
export function hasInlineCommandTokens(text?: string): boolean {
  const body = text ?? "";
  if (!body.trim()) {
    return false;
  }
  return /(?:^|\s)[/!][a-z]/i.test(body);
}

export function shouldComputeCommandAuthorized(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  return isControlCommandMessage(text, cfg, options) || hasInlineCommandTokens(text);
}
