import {
  deleteTgStateFromDb,
  getTgStateFromDb,
  setTgStateInDb,
} from "../infra/state-db/channel-tg-state-sqlite.js";

type TelegramUpdateOffsetState = {
  lastUpdateId: number | null;
  botId: string | null;
};

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function extractBotIdFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  const [rawBotId] = trimmed.split(":", 1);
  if (!rawBotId || !/^\d+$/.test(rawBotId)) {
    return null;
  }
  return rawBotId;
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  const acctId = normalizeAccountId(params.accountId);
  const parsed = getTgStateFromDb<TelegramUpdateOffsetState>(acctId, "update_offset");
  if (!parsed) {
    return null;
  }
  const expectedBotId = extractBotIdFromToken(params.botToken);
  if (expectedBotId && parsed.botId && parsed.botId !== expectedBotId) {
    return null;
  }
  if (expectedBotId && parsed.botId === null) {
    return null;
  }
  return parsed.lastUpdateId ?? null;
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isValidUpdateId(params.updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer.");
  }
  const acctId = normalizeAccountId(params.accountId);
  const payload: TelegramUpdateOffsetState = {
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
  };
  setTgStateInDb(acctId, "update_offset", payload);
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const acctId = normalizeAccountId(params.accountId);
  deleteTgStateFromDb(acctId, "update_offset");
}
