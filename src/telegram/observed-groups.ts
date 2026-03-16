import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelDirectoryEntry } from "../channels/plugins/types.js";
import { resolveStateDir } from "../config/paths.js";

const STORE_VERSION = 1;

type TelegramObservedGroupKind = "group" | "supergroup" | "channel";

type TelegramObservedGroup = {
  chatId: string;
  title?: string;
  username?: string;
  kind: TelegramObservedGroupKind;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSource?: string;
};

type TelegramObservedGroupsState = {
  version: number;
  groups: Record<string, TelegramObservedGroup>;
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveObservedGroupsPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `observed-groups-${normalized}.json`);
}

function safeParseState(raw: string): TelegramObservedGroupsState | null {
  try {
    const parsed = JSON.parse(raw) as TelegramObservedGroupsState;
    if (parsed?.version !== STORE_VERSION) {
      return null;
    }
    if (!parsed.groups || typeof parsed.groups !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readObservedGroupsState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TelegramObservedGroupsState> {
  const filePath = resolveObservedGroupsPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseState(raw) ?? { version: STORE_VERSION, groups: {} };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { version: STORE_VERSION, groups: {} };
    }
    return { version: STORE_VERSION, groups: {} };
  }
}

async function writeObservedGroupsState(params: {
  accountId?: string;
  state: TelegramObservedGroupsState;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveObservedGroupsPath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(params.state, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

function normalizeObservedGroupKind(kind?: string | null): TelegramObservedGroupKind | null {
  const raw = kind?.trim().toLowerCase();
  if (raw === "group" || raw === "supergroup" || raw === "channel") {
    return raw;
  }
  return null;
}

export async function recordObservedTelegramGroup(params: {
  accountId?: string;
  chatId: string | number;
  kind?: string | null;
  title?: string | null;
  username?: string | null;
  source?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const chatId = String(params.chatId ?? "").trim();
  const kind = normalizeObservedGroupKind(params.kind);
  if (!chatId || !kind) {
    return;
  }
  if (!/^-\d+$/.test(chatId)) {
    return;
  }

  const now = new Date().toISOString();
  const state = await readObservedGroupsState({
    accountId: params.accountId,
    env: params.env,
  });
  const current = state.groups[chatId];
  state.groups[chatId] = {
    chatId,
    kind,
    firstSeenAt: current?.firstSeenAt ?? now,
    lastSeenAt: now,
    title: params.title?.trim() || current?.title,
    username: params.username?.trim() || current?.username,
    lastSource: params.source?.trim() || current?.lastSource,
  };
  await writeObservedGroupsState({
    accountId: params.accountId,
    state,
    env: params.env,
  });
}

export async function listObservedTelegramGroups(params: {
  accountId?: string;
  query?: string | null;
  limit?: number | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ChannelDirectoryEntry[]> {
  const state = await readObservedGroupsState({
    accountId: params.accountId,
    env: params.env,
  });
  const query = params.query?.trim().toLowerCase() ?? "";
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : undefined;

  const rows = Object.values(state.groups)
    .filter((group) => {
      if (!query) {
        return true;
      }
      const title = group.title?.toLowerCase() ?? "";
      const username = group.username?.toLowerCase() ?? "";
      return (
        group.chatId.toLowerCase().includes(query) ||
        title.includes(query) ||
        username.includes(query)
      );
    })
    .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .map((group) => ({
      kind: "group" as const,
      id: group.chatId,
      name: group.title,
      handle: group.username ? `@${group.username}` : undefined,
      raw: group,
    }));

  return typeof limit === "number" ? rows.slice(0, limit) : rows;
}
