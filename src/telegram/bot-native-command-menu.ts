import type { Bot } from "grammy";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

export const TELEGRAM_MAX_COMMANDS = 100;

export type TelegramMenuCommand = {
  command: string;
  description: string;
};

type TelegramPluginCommandSpec = {
  name: string;
  description: string;
};

export function buildPluginTelegramMenuCommands(params: {
  specs: TelegramPluginCommandSpec[];
  existingCommands: Set<string>;
}): { commands: TelegramMenuCommand[]; issues: string[] } {
  const { specs, existingCommands } = params;
  const commands: TelegramMenuCommand[] = [];
  const issues: string[] = [];
  const pluginCommandNames = new Set<string>();

  for (const spec of specs) {
    const normalized = normalizeTelegramCommandName(spec.name);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      issues.push(
        `Plugin command "/${spec.name}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
      );
      continue;
    }
    const description = spec.description.trim();
    if (!description) {
      issues.push(`Plugin command "/${normalized}" is missing a description.`);
      continue;
    }
    if (existingCommands.has(normalized)) {
      if (pluginCommandNames.has(normalized)) {
        issues.push(`Plugin command "/${normalized}" is duplicated.`);
      } else {
        issues.push(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`);
      }
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    commands.push({ command: normalized, description });
  }

  return { commands, issues };
}

export function buildCappedTelegramMenuCommands(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands?: number;
}): {
  commandsToRegister: TelegramMenuCommand[];
  totalCommands: number;
  maxCommands: number;
  overflowCount: number;
} {
  const { allCommands } = params;
  const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
  const totalCommands = allCommands.length;
  const overflowCount = Math.max(0, totalCommands - maxCommands);
  const commandsToRegister = allCommands.slice(0, maxCommands);
  return { commandsToRegister, totalCommands, maxCommands, overflowCount };
}

const TELEGRAM_DESCRIPTION_MAX_LENGTH = 256;

function sanitizeTelegramMenuCommands(
  commands: TelegramMenuCommand[],
  runtime: RuntimeEnv,
): TelegramMenuCommand[] {
  const sanitized: TelegramMenuCommand[] = [];
  for (const cmd of commands) {
    if (!TELEGRAM_COMMAND_NAME_PATTERN.test(cmd.command)) {
      runtime.error?.(
        `Telegram command "/${cmd.command}" has an invalid name (must be a-z, 0-9, underscore; 1-32 chars). Skipping.`,
      );
      continue;
    }
    const description = cmd.description?.trim().slice(0, TELEGRAM_DESCRIPTION_MAX_LENGTH);
    if (!description) {
      runtime.error?.(
        `Telegram command "/${cmd.command}" has an empty description. Skipping.`,
      );
      continue;
    }
    sanitized.push({ command: cmd.command, description });
  }
  return sanitized;
}

async function identifyInvalidCommands(
  bot: Bot,
  commands: TelegramMenuCommand[],
): Promise<TelegramMenuCommand[]> {
  const invalid: TelegramMenuCommand[] = [];
  for (const cmd of commands) {
    try {
      await bot.api.setMyCommands([cmd]);
    } catch {
      invalid.push(cmd);
    }
  }
  // Clean up after probing
  await bot.api.deleteMyCommands().catch(() => {});
  return invalid;
}

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
}): void {
  const { bot, runtime } = params;
  const commandsToRegister = sanitizeTelegramMenuCommands(params.commandsToRegister, runtime);
  const sync = async () => {
    // Keep delete -> set ordering to avoid stale deletions racing after fresh registrations.
    if (typeof bot.api.deleteMyCommands === "function") {
      await withTelegramApiErrorLogging({
        operation: "deleteMyCommands",
        runtime,
        fn: () => bot.api.deleteMyCommands(),
      }).catch(() => {});
    }

    if (commandsToRegister.length === 0) {
      return;
    }

    try {
      await bot.api.setMyCommands(commandsToRegister);
    } catch (err) {
      const errText = String((err as Error).message ?? err);
      if (errText.includes("BOT_COMMAND_INVALID")) {
        runtime.error?.(
          `setMyCommands failed (BOT_COMMAND_INVALID) for ${commandsToRegister.length} commands. Identifying invalid entries…`,
        );
        const invalid = await identifyInvalidCommands(bot, commandsToRegister);
        if (invalid.length > 0) {
          for (const cmd of invalid) {
            runtime.error?.(
              `Invalid Telegram command: /${cmd.command} — description: "${cmd.description}"`,
            );
          }
          // Retry without invalid commands
          const valid = commandsToRegister.filter((cmd) => !invalid.includes(cmd));
          if (valid.length > 0) {
            await bot.api.setMyCommands(valid).catch(() => {});
          }
        } else {
          runtime.error?.(
            `setMyCommands failed but all commands pass individually. Dumping: ${JSON.stringify(commandsToRegister.map((c) => c.command))}`,
          );
        }
      } else {
        throw err;
      }
    }
  };

  void sync().catch((err) => {
    runtime.error?.(`Telegram command sync failed: ${String(err)}`);
  });
}
