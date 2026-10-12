/** Normalizes and detects slash commands through their canonical aliases. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { getChatCommands } from "./commands-registry.data.js";
import type { ChatCommandDefinition, CommandNormalizeOptions } from "./commands-registry.types.js";

type TextAliasSpec = {
  command: ChatCommandDefinition;
  canonical: string;
  acceptsArgs: boolean;
};

let cachedTextAliases: Map<string, TextAliasSpec> | undefined;

// Commands whose free-text argument becomes agent input keep every line and its spacing.
const ARGUMENT_PRESERVING_COMMAND_KEYS = new Set(["goal", "steer"]);

const TARGETED_COMMAND_BODY_RE =
  /^\/([^\s@]+)@([A-Za-z0-9_]+)(?=$|\s|[.!?！？…,，。;；:：'"’”)\]}])([\s\S]*)$/u;

function appendMultilineTail(head: string, tail: string | undefined, spec?: TextAliasSpec): string {
  if (!tail) {
    return head;
  }
  if (!spec || spec.command.key === "skill" || spec.command.key === "learn") {
    // `/skill` consumes the skill name before payload content can begin.
    const headArgumentCount = head.split(/\s+/, 3).length - 1;
    const hasPayload = headArgumentCount >= (spec?.command.key === "skill" ? 2 : 1);
    const normalizedTail = hasPayload && spec?.command.key !== "learn" ? tail : tail.trimStart();
    return `${head}\n${normalizedTail}`;
  }
  if (spec.command.key === "reset") {
    const flattened = tail.replace(/\s+/g, " ").trim();
    return flattened ? `${head} ${flattened}` : head;
  }
  return head;
}

function getTextAliases(): Map<string, TextAliasSpec> {
  if (cachedTextAliases) {
    return cachedTextAliases;
  }
  const aliases = new Map<string, TextAliasSpec>();
  for (const command of getChatCommands()) {
    // Canonicalize to the primary text alias, not `/${key}`. Some command keys are
    // internal identifiers while the public text command is a dedicated alias.
    const canonical = normalizeOptionalString(command.textAliases[0]) || `/${command.key}`;
    const acceptsArgs = Boolean(command.acceptsArgs);
    for (const alias of command.textAliases) {
      const normalized = normalizeOptionalLowercaseString(alias);
      if (!normalized) {
        continue;
      }
      if (!aliases.has(normalized)) {
        aliases.set(normalized, { command, canonical, acceptsArgs });
      }
    }
  }
  cachedTextAliases = aliases;
  return aliases;
}

/** Normalizes command text to canonical aliases, removing bot mentions when appropriate. */
export function normalizeCommandBody(raw: string, options?: CommandNormalizeOptions): string {
  const trimmed = options?.preserveArguments ? raw.trimStart() : raw.trim();
  if (!trimmed.startsWith("/")) {
    return trimmed;
  }

  const commandAlias = trimmed.match(/^\/[^\s@:]+/u)?.[0]?.toLowerCase();
  const commandSpec = commandAlias ? getTextAliases().get(commandAlias) : undefined;
  const preserveArguments =
    options?.preserveArguments ||
    (commandSpec !== undefined && ARGUMENT_PRESERVING_COMMAND_KEYS.has(commandSpec.command.key));
  const newline = preserveArguments ? -1 : trimmed.indexOf("\n");
  const singleLine = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();
  // Indentation and blank lines after this boundary can be interior skill payload.
  const multilineTail = newline === -1 ? undefined : trimmed.slice(newline + 1);

  // `/cmd: value` is accepted as `/cmd value` because some channels insert colon syntax.
  const normalized = singleLine.replace(
    /^\/([^\s:]+)\s*:([\s\S]*)$/,
    (_, command: string, rest: string) => {
      const normalizedRest = preserveArguments ? rest : rest.trimStart();
      return normalizedRest
        ? `/${command}${/^\s/.test(normalizedRest) ? "" : " "}${normalizedRest}`
        : `/${command}`;
    },
  );

  const normalizedBotUsername = normalizeOptionalLowercaseString(options?.botUsername);
  const mentionMatch = normalized.match(TARGETED_COMMAND_BODY_RE);
  const targetBotUsername = normalizeOptionalLowercaseString(mentionMatch?.[2]);
  const targetMatchesBot =
    normalizedBotUsername !== undefined && targetBotUsername === normalizedBotUsername;
  const resolveBeforeIdentity =
    normalizedBotUsername === undefined && options?.targetedCommandMode === "pre-identity";
  const commandBody =
    mentionMatch && (targetMatchesBot || resolveBeforeIdentity)
      ? `/${mentionMatch[1]}${mentionMatch[3] ?? ""}`
      : normalized;

  const lowered = normalizeLowercaseStringOrEmpty(commandBody);
  const textAliasMap = getTextAliases();
  const exact = textAliasMap.get(lowered);
  if (exact) {
    return appendMultilineTail(exact.canonical, multilineTail, exact);
  }

  const tokenMatch = commandBody.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!tokenMatch) {
    return appendMultilineTail(commandBody, multilineTail);
  }
  const [, token, rest] = tokenMatch;
  const tokenKey = `/${normalizeLowercaseStringOrEmpty(token)}`;
  const tokenSpec = textAliasMap.get(tokenKey);
  if (!tokenSpec) {
    return appendMultilineTail(commandBody, multilineTail);
  }
  if (rest && !tokenSpec.acceptsArgs) {
    return commandBody;
  }
  const normalizedRest = rest?.trimStart();
  const normalizedHead = preserveArguments
    ? `${tokenSpec.canonical}${commandBody.slice(tokenKey.length)}`
    : normalizedRest
      ? `${tokenSpec.canonical} ${normalizedRest}`
      : tokenSpec.canonical;
  return appendMultilineTail(normalizedHead, multilineTail, tokenSpec);
}

/** Resolves a raw text command to the matching normalized alias when known. */
export function maybeResolveTextAlias(raw: string, _cfg?: OpenClawConfig) {
  const trimmed = normalizeCommandBody(raw).trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  const aliases = getTextAliases();
  const tokenMatch = normalized.match(/^\/([^\s:]+)(?:\s|$)/);
  if (!tokenMatch) {
    return null;
  }
  const tokenKey = `/${tokenMatch[1]}`;
  const spec = aliases.get(tokenKey);
  if (!spec) {
    return null;
  }
  const tail = normalized.slice(tokenKey.length);
  return !tail || spec.acceptsArgs || /^\s*:\s*$/.test(tail) ? tokenKey : null;
}

/** Resolves a raw text command into its command definition and raw argument tail. */
export function resolveTextCommand(
  raw: string,
  cfg?: OpenClawConfig,
): {
  command: ChatCommandDefinition;
  args?: string;
} | null {
  const trimmed = normalizeCommandBody(raw).trim();
  const alias = maybeResolveTextAlias(trimmed, cfg);
  if (!alias) {
    return null;
  }
  const spec = getTextAliases().get(alias);
  if (!spec) {
    return null;
  }
  if (!spec.acceptsArgs) {
    return { command: spec.command };
  }
  const args = trimmed.slice(alias.length).trim();
  return { command: spec.command, args: args || undefined };
}
