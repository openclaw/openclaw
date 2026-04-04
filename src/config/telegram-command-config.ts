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
    preferredBasename: "contract-api.ts",
  });
  if (!contract) {
    throw new Error("telegram command config contract surface is unavailable");
  }
  return contract;
}

export const TELEGRAM_COMMAND_NAME_PATTERN =
  loadTelegramCommandConfigContract().TELEGRAM_COMMAND_NAME_PATTERN;

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
