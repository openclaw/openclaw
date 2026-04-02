import type { OpenClawConfig } from "../config/types.js";
import {
  type CommandNormalizeOptions,
  listChatCommands,
  listChatCommandsForConfig,
  normalizeCommandBody,
} from "./commands-registry.js";
import { isAbortTrigger } from "./reply/abort-primitives.js";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";
import { normalizeThinkLevel } from "./thinking.js";

const THINK_COMMAND_ALIASES = new Set(["think", "thinking", "t"]);

function isCommandNormalizeOptions(
  value: OpenClawConfig | CommandNormalizeOptions | undefined,
): value is CommandNormalizeOptions {
  return typeof value === "object" && value !== null && "botUsername" in value;
}

function getConfiguredModelAliases(cfg?: OpenClawConfig): string[] {
  if (!cfg) {
    return [];
  }
  const reservedCommands = new Set(
    listChatCommands().flatMap((cmd) =>
      cmd.textAliases.map((alias) => alias.replace(/^\//, "").toLowerCase()),
    ),
  );
  return Object.values(cfg.agents?.defaults?.models ?? {})
    .map((entry) => entry.alias?.trim())
    .filter((alias): alias is string => Boolean(alias))
    .filter((alias) => !reservedCommands.has(alias.toLowerCase()));
}

function isDirectiveOnlyTail(text: string, cfg?: OpenClawConfig): boolean {
  const parsed = parseInlineDirectives(text, {
    modelAliases: getConfiguredModelAliases(cfg),
  });
  if (parsed.cleaned.trim().length > 0) {
    return false;
  }
  return (
    parsed.hasThinkDirective ||
    parsed.hasFastDirective ||
    parsed.hasVerboseDirective ||
    parsed.hasReasoningDirective ||
    parsed.hasElevatedDirective ||
    parsed.hasExecDirective ||
    parsed.hasStatusDirective ||
    parsed.hasModelDirective ||
    parsed.hasQueueDirective
  );
}

type OneShotThinkParseResult =
  | { kind: "one-shot"; level: string; body: string }
  | { kind: "invalid-tail" };

function parseOneShotThinkMessage(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): OneShotThinkParseResult | null {
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
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return null;
  }
  // Keep slash-command and directive-only tails on the control-command path so invalid
  // inputs like `/think high /status` or `/think high /new` do not persist `/think high`.
  // Plain abort text such as `stop` is still valid message content here.
  if (hasControlCommand(trimmedBody, cfg, options) || isDirectiveOnlyTail(trimmedBody, cfg)) {
    return { kind: "invalid-tail" };
  }
  return { kind: "one-shot", level: rawLevel, body };
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
  const stripped = stripInboundMetadata(trimmed);
  if (!stripped) {
    return false;
  }
  const normalizedBody = normalizeCommandBody(stripped, options);
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
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Detect one-shot think messages: `/think <level> <body>`.
 * These still behave like slash commands for auth/gating/debounce, but the think level
 * should only apply to the current message instead of persisting to session state.
 */
export function isOneShotThinkMessage(text?: string, options?: CommandNormalizeOptions): boolean;
export function isOneShotThinkMessage(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean;
export function isOneShotThinkMessage(
  text?: string,
  cfg?: OpenClawConfig | CommandNormalizeOptions,
  options?: CommandNormalizeOptions,
): boolean {
  const normalizedCfg = isCommandNormalizeOptions(cfg) ? undefined : cfg;
  const normalizedOptions = isCommandNormalizeOptions(cfg) ? cfg : options;
  return parseOneShotThinkMessage(text, normalizedCfg, normalizedOptions)?.kind === "one-shot";
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
  const stripped = stripInboundMetadata(trimmed);
  const normalized = normalizeCommandBody(stripped, options).trim().toLowerCase();
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
