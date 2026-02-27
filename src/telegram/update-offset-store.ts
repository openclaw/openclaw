import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { getDatastore } from "../infra/datastore.js";

const STORE_VERSION = 2;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveTelegramUpdateOffsetPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
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

function safeParseState(raw: unknown): TelegramUpdateOffsetState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const parsed = raw as {
    version?: number;
    lastUpdateId?: number | null;
    botId?: string | null;
  };
  if (parsed?.version !== STORE_VERSION && parsed?.version !== 1) {
    return null;
  }
  if (parsed.lastUpdateId !== null && typeof parsed.lastUpdateId !== "number") {
    return null;
  }
  if (
    parsed.version === STORE_VERSION &&
    parsed.botId !== null &&
    typeof parsed.botId !== "string"
  ) {
    return null;
  }
  return {
    version: STORE_VERSION,
    lastUpdateId: parsed.lastUpdateId ?? null,
    botId: parsed.version === STORE_VERSION ? (parsed.botId ?? null) : null,
  };
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const raw = getDatastore().read(filePath);
  const parsed = safeParseState(raw);
  const expectedBotId = extractBotIdFromToken(params.botToken);
  if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) {
    return null;
  }
  if (expectedBotId && parsed?.botId === null) {
    return null;
  }
  return parsed?.lastUpdateId ?? null;
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
  };
  await getDatastore().write(filePath, payload);
  // best-effort: restrict permissions on the file (security-sensitive bot tokens)
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // no-op — postgres backend has no file to chmod
  }
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  await getDatastore().delete(filePath);
}
