/** Command detectors used by inbound authorization and control-command routing. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { matchPluginCommand } from "../plugins/commands.js";
import { listChatCommands, listChatCommandsForConfig } from "./commands-registry-list.js";
import { normalizeCommandBody } from "./commands-registry-normalize.js";
import type { CommandNormalizeOptions } from "./commands-registry.types.js";
import { isAbortTrigger } from "./reply/abort-trigger-text.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";

function normalizeControlCommandBody(text?: string, options?: CommandNormalizeOptions): string {
  return normalizeCommandBody(stripInboundMetadata(text?.trim() ?? ""), options);
}

function hasNormalizedControlCommand(normalizedBody: string, cfg?: OpenClawConfig): boolean {
  if (!normalizedBody) {
    return false;
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalizedBody);
  const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
  return commands.some((command) =>
    command.textAliases.some((alias) => {
      const normalized = normalizeOptionalLowercaseString(alias);
      return Boolean(
        normalized &&
        (lowered === normalized ||
          (command.acceptsArgs &&
            lowered.startsWith(normalized) &&
            /\s/.test(normalizedBody.charAt(normalized.length)))),
      );
    }),
  );
}

/** Returns true when text starts with a configured control command alias. */
export function hasControlCommand(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  return hasNormalizedControlCommand(normalizeControlCommandBody(text, options), cfg);
}

/** Returns true for exact control commands or abort triggers after metadata stripping. */
export function isControlCommandMessage(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  const normalizedBody = normalizeControlCommandBody(text, options);
  return (
    hasNormalizedControlCommand(normalizedBody, cfg) ||
    isAbortTrigger(normalizeLowercaseStringOrEmpty(normalizedBody))
  );
}

/** Returns true when a command starts a new transcript rather than resetting in place. */
export function isSessionBoundaryCommandText(
  text?: string,
  options?: CommandNormalizeOptions,
): boolean {
  const normalized = normalizeControlCommandBody(text, options);
  return (
    /^\/(?:new|reset)(?:\s|$)/i.test(normalized) && !/^\/reset\s+soft(?:\s|$)/i.test(normalized)
  );
}

/**
 * Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
 * can decide whether to compute CommandAuthorized for a message.
 *
 * This intentionally errs on the side of false positives; CommandAuthorized only gates
 * command/directive execution, not normal chat replies.
 */
export function hasInlineCommandTokens(text?: string): boolean {
  return /(?:^|\s)[/!][a-z]/i.test(text ?? "");
}

function hasSpacedPluginCommand(text?: string): boolean {
  const commandBody = text?.match(/(?:^|\s)(\/\s+[a-z][\s\S]*)/i)?.[1];
  // Only active registered commands affect ingress authorization and mention gating.
  // This keeps spaced syntax aligned with canonical `/name` command ownership.
  return commandBody ? matchPluginCommand(commandBody) !== null : false;
}

/** Returns true when a message may need command authorization metadata. */
export function shouldComputeCommandAuthorized(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  return (
    isControlCommandMessage(text, cfg, options) ||
    hasInlineCommandTokens(text) ||
    hasSpacedPluginCommand(text)
  );
}
