import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeTelegramCommandName,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "../config/telegram-custom-commands.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

export const TELEGRAM_MAX_COMMANDS = 100;
const TELEGRAM_COMMAND_RETRY_RATIO = 0.8;

export type TelegramMenuCommand = {
  command: string;
  description: string;
};

type TelegramPluginCommandSpec = {
  name: unknown;
  description: unknown;
};

function isBotCommandsTooMuchError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const pattern = /\bBOT_COMMANDS_TOO_MUCH\b/i;
  if (typeof err === "string") {
    return pattern.test(err);
  }
  if (err instanceof Error) {
    if (pattern.test(err.message)) {
      return true;
    }
  }
  if (typeof err === "object") {
    const maybe = err as { description?: unknown; message?: unknown };
    if (typeof maybe.description === "string" && pattern.test(maybe.description)) {
      return true;
    }
    if (typeof maybe.message === "string" && pattern.test(maybe.message)) {
      return true;
    }
  }
  return false;
}

export function buildPluginTelegramMenuCommands(params: {
  specs: TelegramPluginCommandSpec[];
  existingCommands: Set<string>;
}): { commands: TelegramMenuCommand[]; issues: string[] } {
  const { specs, existingCommands } = params;
  const commands: TelegramMenuCommand[] = [];
  const issues: string[] = [];
  const pluginCommandNames = new Set<string>();

  for (const spec of specs) {
    const rawName = typeof spec.name === "string" ? spec.name : "";
    const normalized = normalizeTelegramCommandName(rawName);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      const invalidName = rawName.trim() ? rawName : "<unknown>";
      issues.push(
        `Plugin command "/${invalidName}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
      );
      continue;
    }
    const description = typeof spec.description === "string" ? spec.description.trim() : "";
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

/** Compute a stable hash of the command list for change detection. */
export function hashCommandList(commands: TelegramMenuCommand[]): string {
  const sorted = [...commands].toSorted((a, b) => a.command.localeCompare(b.command));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

function resolveCommandHashPath(accountId?: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const normalized = accountId?.trim().replace(/[^a-z0-9._-]+/gi, "_") || "default";
  return path.join(stateDir, "telegram", `command-hash-${normalized}.txt`);
}

async function readCachedCommandHash(accountId?: string): Promise<string | null> {
  try {
    return (await fs.readFile(resolveCommandHashPath(accountId), "utf-8")).trim();
  } catch {
    return null;
  }
}

async function writeCachedCommandHash(accountId?: string, hash?: string): Promise<void> {
  if (!hash) {
    return;
  }
  const filePath = resolveCommandHashPath(accountId);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, hash, "utf-8");
  } catch {
    // Best-effort: failing to cache the hash just means the next restart
    // will sync commands again, which is the pre-fix behaviour.
  }
}

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
  accountId?: string;
}): void {
  const { bot, runtime, commandsToRegister, accountId } = params;
  const sync = async () => {
    // Skip sync if the command list hasn't changed since the last successful
    // sync. This prevents hitting Telegram's 429 rate limit when the gateway
    // is restarted several times in quick succession.
    // See: openclaw/openclaw#32017
    const currentHash = hashCommandList(commandsToRegister);
    const cachedHash = await readCachedCommandHash(accountId);
    if (cachedHash === currentHash) {
      runtime.log?.("telegram: command menu unchanged; skipping sync");
      return;
    }

    // Keep delete -> set ordering to avoid stale deletions racing after fresh registrations.
    if (typeof bot.api.deleteMyCommands === "function") {
      await withTelegramApiErrorLogging({
        operation: "deleteMyCommands",
        runtime,
        fn: () => bot.api.deleteMyCommands(),
      }).catch(() => {});
    }

    if (commandsToRegister.length === 0) {
      await writeCachedCommandHash(accountId, currentHash);
      return;
    }

    let retryCommands = commandsToRegister;
    while (retryCommands.length > 0) {
      try {
        await withTelegramApiErrorLogging({
          operation: "setMyCommands",
          runtime,
          fn: () => bot.api.setMyCommands(retryCommands),
        });
        await writeCachedCommandHash(accountId, currentHash);
        return;
      } catch (err) {
        if (!isBotCommandsTooMuchError(err)) {
          throw err;
        }
        const nextCount = Math.floor(retryCommands.length * TELEGRAM_COMMAND_RETRY_RATIO);
        const reducedCount =
          nextCount < retryCommands.length ? nextCount : retryCommands.length - 1;
        if (reducedCount <= 0) {
          runtime.error?.(
            "Telegram rejected native command registration (BOT_COMMANDS_TOO_MUCH); leaving menu empty. Reduce commands or disable channels.telegram.commands.native.",
          );
          return;
        }
        runtime.log?.(
          `Telegram rejected ${retryCommands.length} commands (BOT_COMMANDS_TOO_MUCH); retrying with ${reducedCount}.`,
        );
        retryCommands = retryCommands.slice(0, reducedCount);
      }
    }
  };

  void sync().catch((err) => {
    runtime.error?.(`Telegram command sync failed: ${String(err)}`);
  });
}
