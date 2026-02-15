import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const STORE_VERSION = 1;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  tokenHash?: string;
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
    if (parsed?.version !== STORE_VERSION) {
      return null;
    }
    if (parsed.lastUpdateId !== null && typeof parsed.lastUpdateId !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  tokenHash?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = safeParseState(raw);
    if (!parsed) {
      return null;
    }
    // When the caller supplies a tokenHash, discard a stale offset that was
    // written for a different bot token.  This prevents a token swap from
    // causing all incoming updates to be silently skipped.
    if (params.tokenHash && parsed.tokenHash && parsed.tokenHash !== params.tokenHash) {
      return null;
    }
    return parsed.lastUpdateId ?? null;
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
  tokenHash?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    ...(params.tokenHash ? { tokenHash: params.tokenHash } : {}),
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

export function computeBotTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}
