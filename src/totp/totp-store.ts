import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import {
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  verifyTotp,
  buildOtpauthUri,
} from "./totp.js";

const TOTP_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export type TotpUserEntry = {
  telegramUserId: string;
  secretBase32: string;
  enrolledAt: string;
  label?: string;
};

export type TotpSession = {
  telegramUserId: string;
  authenticatedAt: string;
  expiresAt: string;
};

export type TotpRateLimit = {
  telegramUserId: string;
  attempts: number;
  windowStart: string;
};

type TotpStore = {
  version: 1;
  users: TotpUserEntry[];
  sessions: TotpSession[];
  rateLimits: TotpRateLimit[];
};

const EMPTY_STORE: TotpStore = { version: 1, users: [], sessions: [], rateLimits: [] };

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return resolveOAuthDir(env, stateDir);
}

function resolveTotpStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCredentialsDir(env), "telegram-totp.json");
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = safeParseJson<T>(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8" });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

async function ensureJsonFile(filePath: string, fallback: unknown) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await ensureJsonFile(filePath, EMPTY_STORE);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, TOTP_STORE_LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore unlock errors
      }
    }
  }
}

/** Enroll a Telegram user for TOTP 2FA. Returns the secret and otpauth URI. */
export async function enrollTotpUser(
  userId: string,
  label?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ secretBase32: string; otpauthUri: string }> {
  const filePath = resolveTotpStorePath(env);
  return await withFileLock(filePath, async () => {
    const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
    const existing = store.users.find((u) => u.telegramUserId === userId);
    if (existing) {
      throw new Error(`User ${userId} is already enrolled in TOTP`);
    }
    const secret = generateTotpSecret();
    const secretBase32 = encodeBase32(secret);
    const entry: TotpUserEntry = {
      telegramUserId: userId,
      secretBase32,
      enrolledAt: new Date().toISOString(),
      ...(label ? { label } : {}),
    };
    store.users.push(entry);
    await writeJsonFile(filePath, store);
    const otpauthUri = buildOtpauthUri({
      secret: secretBase32,
      issuer: "OpenClaw",
      account: label || userId,
    });
    return { secretBase32, otpauthUri };
  });
}

/** Remove a user's TOTP enrollment and any active sessions. */
export async function revokeTotpUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = resolveTotpStorePath(env);
  return await withFileLock(filePath, async () => {
    const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
    const idx = store.users.findIndex((u) => u.telegramUserId === userId);
    if (idx < 0) {
      return false;
    }
    store.users.splice(idx, 1);
    store.sessions = store.sessions.filter((s) => s.telegramUserId !== userId);
    store.rateLimits = store.rateLimits.filter((r) => r.telegramUserId !== userId);
    await writeJsonFile(filePath, store);
    return true;
  });
}

/** List all enrolled TOTP users. */
export async function listTotpUsers(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TotpUserEntry[]> {
  const filePath = resolveTotpStorePath(env);
  const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
  return Array.isArray(store.users) ? store.users : [];
}

/** Check if a user is enrolled in TOTP. */
export async function isUserEnrolled(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = resolveTotpStorePath(env);
  const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
  return (store.users ?? []).some((u) => u.telegramUserId === userId);
}

/** Check rate limit. Returns true if the attempt is allowed. */
export async function checkRateLimit(
  userId: string,
  maxAttempts: number,
  windowSec: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = resolveTotpStorePath(env);
  return await withFileLock(filePath, async () => {
    const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
    const now = Date.now();
    let entry = store.rateLimits.find((r) => r.telegramUserId === userId);
    if (entry) {
      const windowStart = Date.parse(entry.windowStart);
      if (!Number.isFinite(windowStart) || now - windowStart > windowSec * 1000) {
        entry.attempts = 0;
        entry.windowStart = new Date().toISOString();
      }
      if (entry.attempts >= maxAttempts) {
        await writeJsonFile(filePath, store);
        return false;
      }
    }
    return true;
  });
}

/** Verify TOTP code, enforce rate limits, and create a session on success. */
export async function verifyAndCreateSession(
  userId: string,
  code: string,
  sessionDurationSec: number,
  maxAttempts: number,
  windowSec: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = resolveTotpStorePath(env);
  return await withFileLock(filePath, async () => {
    const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
    const user = store.users.find((u) => u.telegramUserId === userId);
    if (!user) {
      return false;
    }

    // Rate limit check
    const now = Date.now();
    let rateEntry = store.rateLimits.find((r) => r.telegramUserId === userId);
    if (!rateEntry) {
      rateEntry = { telegramUserId: userId, attempts: 0, windowStart: new Date().toISOString() };
      store.rateLimits.push(rateEntry);
    }
    const windowStart = Date.parse(rateEntry.windowStart);
    if (!Number.isFinite(windowStart) || now - windowStart > windowSec * 1000) {
      rateEntry.attempts = 0;
      rateEntry.windowStart = new Date().toISOString();
    }
    if (rateEntry.attempts >= maxAttempts) {
      await writeJsonFile(filePath, store);
      return false;
    }

    const secret = decodeBase32(user.secretBase32);
    const valid = verifyTotp(secret, code);
    if (!valid) {
      rateEntry.attempts += 1;
      await writeJsonFile(filePath, store);
      return false;
    }

    // Success: reset rate limit, create session
    rateEntry.attempts = 0;
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(now + sessionDurationSec * 1000).toISOString();
    // Remove any existing session for this user
    store.sessions = store.sessions.filter((s) => s.telegramUserId !== userId);
    store.sessions.push({
      telegramUserId: userId,
      authenticatedAt: nowIso,
      expiresAt,
    });
    await writeJsonFile(filePath, store);
    return true;
  });
}

/** Check if a user has a valid (non-expired) TOTP session. */
export async function hasValidSession(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = resolveTotpStorePath(env);
  const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
  const now = Date.now();
  return (store.sessions ?? []).some((s) => {
    if (s.telegramUserId !== userId) return false;
    const expires = Date.parse(s.expiresAt);
    return Number.isFinite(expires) && now < expires;
  });
}

/** Clear a user's active TOTP session (force re-authentication). */
export async function clearSession(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = resolveTotpStorePath(env);
  return await withFileLock(filePath, async () => {
    const store = await readJsonFile<TotpStore>(filePath, { ...EMPTY_STORE });
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.telegramUserId !== userId);
    if (store.sessions.length === before) {
      return false;
    }
    await writeJsonFile(filePath, store);
    return true;
  });
}
