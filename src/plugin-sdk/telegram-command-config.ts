import { getBundledChannelContractSurfaceModule } from "../channels/plugins/contract-surfaces.js";

export type TelegramCustomCommandInput = {
  command?: string | null;
  description?: string | null;
};

export type TelegramCustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};

type TelegramCommandConfigContract = {
  TELEGRAM_COMMAND_NAME_PATTERN: RegExp;
  normalizeTelegramCommandName: (value: string) => string;
  normalizeTelegramCommandDescription: (value: string) => string;
  resolveTelegramCustomCommands: (params: {
    commands?: TelegramCustomCommandInput[] | null;
    reservedCommands?: Set<string>;
    checkReserved?: boolean;
    checkDuplicates?: boolean;
  }) => {
    commands: Array<{ command: string; description: string }>;
    issues: TelegramCustomCommandIssue[];
  };
};

const FALLBACK_TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
let cachedTelegramCommandConfigContract: TelegramCommandConfigContract | null = null;

function fallbackNormalizeTelegramCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return withoutSlash.trim().toLowerCase().replace(/-/g, "_");
}

function fallbackNormalizeTelegramCommandDescription(value: string): string {
  return value.trim();
}

function fallbackResolveTelegramCustomCommands(params: {
  commands?: TelegramCustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: TelegramCustomCommandIssue[];
} {
  const entries = Array.isArray(params.commands) ? params.commands : [];
  const reserved = params.reservedCommands ?? new Set<string>();
  const checkReserved = params.checkReserved !== false;
  const checkDuplicates = params.checkDuplicates !== false;
  const seen = new Set<string>();
  const resolved: Array<{ command: string; description: string }> = [];
  const issues: TelegramCustomCommandIssue[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalized = fallbackNormalizeTelegramCommandName(String(entry?.command ?? ""));
    if (!normalized) {
      issues.push({
        index,
        field: "command",
        message: "Telegram custom command is missing a command name.",
      });
      continue;
    }
    if (!FALLBACK_TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Telegram custom command "/${normalized}" is invalid (use a-z, 0-9, underscore; max 32 chars).`,
      });
      continue;
    }
    if (checkReserved && reserved.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Telegram custom command "/${normalized}" conflicts with a native command.`,
      });
      continue;
    }
    if (checkDuplicates && seen.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `Telegram custom command "/${normalized}" is duplicated.`,
      });
      continue;
    }
    const description = fallbackNormalizeTelegramCommandDescription(
      String(entry?.description ?? ""),
    );
    if (!description) {
      issues.push({
        index,
        field: "description",
        message: `Telegram custom command "/${normalized}" is missing a description.`,
      });
      continue;
    }
    if (checkDuplicates) {
      seen.add(normalized);
    }
    resolved.push({ command: normalized, description });
  }

  return { commands: resolved, issues };
}

const FALLBACK_TELEGRAM_COMMAND_CONFIG_CONTRACT: TelegramCommandConfigContract = {
  TELEGRAM_COMMAND_NAME_PATTERN: FALLBACK_TELEGRAM_COMMAND_NAME_PATTERN,
  normalizeTelegramCommandName: fallbackNormalizeTelegramCommandName,
  normalizeTelegramCommandDescription: fallbackNormalizeTelegramCommandDescription,
  resolveTelegramCustomCommands: fallbackResolveTelegramCustomCommands,
};

function loadTelegramCommandConfigContract(): TelegramCommandConfigContract {
  cachedTelegramCommandConfigContract ??=
    getBundledChannelContractSurfaceModule<TelegramCommandConfigContract>({
      pluginId: "telegram",
      preferredBasename: "contract-surfaces.ts",
    }) ?? FALLBACK_TELEGRAM_COMMAND_CONFIG_CONTRACT;
  return cachedTelegramCommandConfigContract;
}

export function getTelegramCommandNamePattern(): RegExp {
  return loadTelegramCommandConfigContract().TELEGRAM_COMMAND_NAME_PATTERN;
}

/**
 * @deprecated Use `getTelegramCommandNamePattern()` when you need the live
 * bundled contract value. This export remains an import-time-safe fallback.
 */
export const TELEGRAM_COMMAND_NAME_PATTERN = FALLBACK_TELEGRAM_COMMAND_NAME_PATTERN;

export function normalizeTelegramCommandName(value: string): string {
  return loadTelegramCommandConfigContract().normalizeTelegramCommandName(value);
}

export function normalizeTelegramCommandDescription(value: string): string {
  return loadTelegramCommandConfigContract().normalizeTelegramCommandDescription(value);
}

export function resolveTelegramCustomCommands(params: {
  commands?: TelegramCustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: TelegramCustomCommandIssue[];
} {
  return loadTelegramCommandConfigContract().resolveTelegramCustomCommands(params);
}
