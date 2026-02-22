import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const STORE_VERSION = 2;

type TelegramUpdateOffsetStateV1 = {
  version: 1;
  lastUpdateId: number | null;
};

type TelegramUpdateOffsetStateV2 = {
  version: 2;
  lastUpdateId: number | null;
  tokenFingerprint?: string;
};

type TelegramUpdateOffsetState = TelegramUpdateOffsetStateV1 | TelegramUpdateOffsetStateV2;

const resolveTokenFingerprint = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
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

function safeParseState(raw: string): TelegramUpdateOffsetState | null {
  try {
    const parsed = JSON.parse(raw) as TelegramUpdateOffsetState;
    if (!parsed || parsed.version !== STORE_VERSION) {
      return null;
    }
    if (parsed.lastUpdateId !== null && typeof parsed.lastUpdateId !== "number") {
      return null;
    }
    if ("tokenFingerprint" in parsed && typeof parsed.tokenFingerprint !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  token?: string;
}): Promise<number | null> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = safeParseState(raw);
    if (!parsed || parsed.version !== 2) {
      return null;
    }
    if (typeof params.token === "string" && params.token.length > 0) {
      const expectedFingerprint = resolveTokenFingerprint(params.token);
      if (!parsed.tokenFingerprint || parsed.tokenFingerprint !== expectedFingerprint) {
        return null;
      }
    }
    return parsed.lastUpdateId;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  env?: NodeJS.ProcessEnv;
  token?: string;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload: TelegramUpdateOffsetStateV2 = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    tokenFingerprint:
      typeof params.token === "string" && params.token.length > 0
        ? resolveTokenFingerprint(params.token)
        : undefined,
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}
