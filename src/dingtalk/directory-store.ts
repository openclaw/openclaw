import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";

const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

const KNOWN_USERS_FILENAME = "dingtalk-known-users.json";

export type DingTalkKnownUser = {
  userId: string;
  name?: string;
  lastSeenAt: string;
};

type DingTalkKnownUsersStore = {
  version: 1;
  users: DingTalkKnownUser[];
};

function resolveKnownUsersPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  return path.join(oauthDir, KNOWN_USERS_FILENAME);
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readStore(filePath: string): Promise<DingTalkKnownUsersStore> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = safeParseJson<DingTalkKnownUsersStore>(raw);
    if (!parsed || !Array.isArray(parsed.users)) {
      return { version: 1, users: [] };
    }
    return {
      version: 1,
      users: parsed.users
        .filter((item) => item && typeof item.userId === "string")
        .map((item) => ({
          userId: normalizeUserId(item.userId),
          name: normalizeName(item.name),
          lastSeenAt:
            typeof item.lastSeenAt === "string" && item.lastSeenAt.trim()
              ? item.lastSeenAt
              : new Date(0).toISOString(),
        }))
        .filter((item) => Boolean(item.userId)),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { version: 1, users: [] };
    }
    return { version: 1, users: [] };
  }
}

async function writeStore(filePath: string, value: DingTalkKnownUsersStore): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${Date.now()}.tmp`);
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

async function ensureStoreFile(filePath: string): Promise<void> {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeStore(filePath, { version: 1, users: [] });
  }
}

async function withStoreLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await ensureStoreFile(filePath);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, STORE_LOCK_OPTIONS);
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

function normalizeUserId(value: string | number): string {
  return String(value)
    .trim()
    .replace(/^(dingtalk|dingtalk-connector|dd|ding):/i, "");
}

function normalizeName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function readDingTalkKnownUsers(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DingTalkKnownUser[]> {
  const filePath = resolveKnownUsersPath(env);
  const store = await readStore(filePath);
  return store.users.toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function upsertDingTalkKnownUser(params: {
  userId: string | number;
  name?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; entry: DingTalkKnownUser | null }> {
  const env = params.env ?? process.env;
  const userId = normalizeUserId(params.userId);
  if (!userId) {
    return { changed: false, entry: null };
  }
  const name = normalizeName(params.name);
  const filePath = resolveKnownUsersPath(env);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    const now = new Date().toISOString();
    const idx = store.users.findIndex((item) => item.userId === userId);
    if (idx >= 0) {
      const existing = store.users[idx];
      if (!existing) {
        return { changed: false, entry: null };
      }
      const next: DingTalkKnownUser = {
        userId,
        name: name ?? existing.name,
        lastSeenAt: now,
      };
      const changed = next.name !== existing.name || next.lastSeenAt !== existing.lastSeenAt;
      if (changed) {
        store.users[idx] = next;
        await writeStore(filePath, { version: 1, users: store.users });
      }
      return { changed, entry: next };
    }
    const entry: DingTalkKnownUser = { userId, name, lastSeenAt: now };
    store.users.push(entry);
    await writeStore(filePath, { version: 1, users: store.users });
    return { changed: true, entry };
  });
}
