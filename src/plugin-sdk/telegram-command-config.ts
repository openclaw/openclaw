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

function loadTelegramCommandConfigContract(): TelegramCommandConfigContract {
  const contract = getBundledChannelContractSurfaceModule<TelegramCommandConfigContract>({
    pluginId: "telegram",
    preferredBasename: "contract-surfaces.ts",
  });
  if (!contract) {
    throw new Error("telegram command config contract surface is unavailable");
  }
  return contract;
}

/**
 * Telegram Bot API command name pattern: lowercase alphanumeric and underscores, 1-32 chars.
 *
 * This constant is intentionally inlined rather than loaded from the telegram
 * extension contract surface.  The previous implementation called
 * `loadTelegramCommandConfigContract()` at **module load time** to obtain this
 * value, which triggered a circular dependency when the telegram extension's
 * `contract-api.ts` (or `contract-surfaces.ts`) transitively imported
 * `plugin-sdk/config-runtime` → `plugin-sdk/telegram-command-config` before
 * the extension module had finished initializing.  jiti returned `null` for
 * the still-loading module, causing the gateway to crash on startup with
 * "telegram command config contract surface is unavailable".
 *
 * The regex mirrors `extensions/telegram/src/command-config.ts` line 1 exactly
 * and matches the Telegram Bot API specification for command names.
 */
export const TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

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
