import {
  normalizeCommandDescription,
  normalizeSlashCommandName,
  resolveCustomCommands,
} from "../shared/custom-command-config.js";

/** Deprecated Telegram SDK command config input retained for external callers. */
export type TelegramCustomCommandInput = {
  command?: string | null;
  description?: string | null;
};

/** Validation issue shape returned alongside accepted Telegram custom commands. */
export type TelegramCustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};
const TELEGRAM_COMMAND_NAME_PATTERN_VALUE = /^[a-z0-9_]{1,32}$/;
const TELEGRAM_CUSTOM_COMMAND_CONFIG = {
  label: "Telegram",
  pattern: TELEGRAM_COMMAND_NAME_PATTERN_VALUE,
  patternDescription: "use a-z, 0-9, underscore; max 32 chars",
} as const;

function normalizeTelegramCommandNameImpl(value: string): string {
  return normalizeSlashCommandName(value);
}

function normalizeTelegramCommandDescriptionImpl(value: string): string {
  return normalizeCommandDescription(value);
}

function resolveTelegramCustomCommandsImpl(params: {
  commands?: TelegramCustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: TelegramCustomCommandIssue[];
} {
  // Keep Telegram's deprecated SDK surface on the shared command resolver so
  // normalization, duplicate detection, and reserved-command wording do not
  // drift from newer plugin-local command config paths.
  return resolveCustomCommands({
    ...params,
    config: TELEGRAM_CUSTOM_COMMAND_CONFIG,
  });
}

/** Return the legacy Telegram command-name pattern object for identity-based callers. */
export function getTelegramCommandNamePattern(): RegExp {
  return TELEGRAM_COMMAND_NAME_PATTERN_VALUE;
}

/** Legacy Telegram command-name regex: lowercase ASCII letters, digits, and underscores. */
export const TELEGRAM_COMMAND_NAME_PATTERN = TELEGRAM_COMMAND_NAME_PATTERN_VALUE;

/** Normalize slash-prefixed Telegram command names to the stored lowercase form. */
export function normalizeTelegramCommandName(value: string): string {
  return normalizeTelegramCommandNameImpl(value);
}

/** Trim Telegram command descriptions without applying provider-specific text policy. */
export function normalizeTelegramCommandDescription(value: string): string {
  return normalizeTelegramCommandDescriptionImpl(value);
}

/** Resolve accepted Telegram custom commands plus indexed validation issues. */
export function resolveTelegramCustomCommands(params: {
  commands?: TelegramCustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: TelegramCustomCommandIssue[];
} {
  return resolveTelegramCustomCommandsImpl(params);
}
