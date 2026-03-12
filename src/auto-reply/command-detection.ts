import type { OpenClawConfig } from "../config/types.js";
import {
  type CommandNormalizeOptions,
  listChatCommands,
  listChatCommandsForConfig,
  normalizeCommandBody,
} from "./commands-registry.js";
import { isAbortTrigger } from "./reply/abort.js";
import { normalizeThinkLevel } from "./thinking.js";

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
 * These should NOT be treated as control commands — they carry a message body
 * that needs AI processing, with the think level applied for that single message only.
 */
export function isOneShotThinkMessage(text?: string, options?: CommandNormalizeOptions): boolean {
  if (!text) {
    return false;
  }
  const body = normalizeCommandBody(text.trim(), options);
  if (!body) {
    return false;
  }
  // normalizeCommandBody resolves aliases (/t, /thinking → /think), so only match canonical form.
  const match = body.match(/^\/think\s+(\S+)\s+\S/i);
  if (!match) {
    return false;
  }
  return normalizeThinkLevel(match[1]) !== undefined;
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
