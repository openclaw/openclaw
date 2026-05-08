import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  deleteOpenClawStateKvJson,
  listOpenClawStateKvJson,
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import type { TuiSessionList } from "./tui-backend.js";
import type { SessionScope } from "./tui-types.js";

type LastSessionRecord = {
  sessionKey: string;
  updatedAt: number;
};

type LastSessionStore = Record<string, LastSessionRecord>;
const TUI_LAST_SESSION_KV_SCOPE = "tui:last-session";

export function resolveLegacyTuiLastSessionStatePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "tui", "last-session.json");
}

export function buildTuiLastSessionScopeKey(params: {
  connectionUrl: string;
  agentId: string;
  sessionScope: SessionScope;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const connectionUrl = params.connectionUrl.trim() || "local";
  return createHash("sha256")
    .update(`${params.sessionScope}\n${agentId}\n${connectionUrl}`)
    .digest("hex")
    .slice(0, 32);
}

async function readStore(filePath: string): Promise<LastSessionStore> {
  try {
    const parsed = await privateFileStore(path.dirname(filePath)).readJsonIfExists(
      path.basename(filePath),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LastSessionStore)
      : {};
  } catch {
    return {};
  }
}

async function deleteStore(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

function stateKvOptionsForStateDir(stateDir?: string) {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function normalizeLastSessionRecord(value: unknown): LastSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : null;
  if (!sessionKey || updatedAt === null || !Number.isFinite(updatedAt)) {
    return null;
  }
  return { sessionKey, updatedAt };
}

function writeTuiLastSessionKv(params: {
  scopeKey: string;
  record: LastSessionRecord;
  stateDir?: string;
}): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    TUI_LAST_SESSION_KV_SCOPE,
    params.scopeKey,
    params.record,
    stateKvOptionsForStateDir(params.stateDir),
  );
}

async function readLegacyTuiLastSessionStore(params: {
  stateDir?: string;
}): Promise<LastSessionStore> {
  const filePath = resolveLegacyTuiLastSessionStatePath(params.stateDir);
  return await readStore(filePath);
}

export async function legacyTuiLastSessionFileExists(
  params: {
    stateDir?: string;
  } = {},
): Promise<boolean> {
  try {
    await fs.access(resolveLegacyTuiLastSessionStatePath(params.stateDir));
    return true;
  } catch {
    return false;
  }
}

export async function importLegacyTuiLastSessionStoreToSqlite(
  params: {
    stateDir?: string;
  } = {},
): Promise<{ imported: boolean; pointers: number }> {
  const filePath = resolveLegacyTuiLastSessionStatePath(params.stateDir);
  const exists = await legacyTuiLastSessionFileExists(params);
  if (!exists) {
    return { imported: false, pointers: 0 };
  }
  const store = await readLegacyTuiLastSessionStore(params);
  let pointers = 0;
  for (const [scopeKey, value] of Object.entries(store)) {
    const record = normalizeLastSessionRecord(value);
    if (!record) {
      continue;
    }
    writeTuiLastSessionKv({
      scopeKey,
      record,
      stateDir: params.stateDir,
    });
    pointers += 1;
  }
  await deleteStore(filePath);
  return { imported: true, pointers };
}

function normalizeMarker(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isHeartbeatSessionKey(sessionKey: string): boolean {
  return normalizeMarker(sessionKey).endsWith(":heartbeat");
}

export function isHeartbeatLikeTuiSession(session: TuiSessionList["sessions"][number]): boolean {
  if (isHeartbeatSessionKey(session.key)) {
    return true;
  }
  const markers = [
    session.provider,
    session.lastProvider,
    session.lastChannel,
    session.lastTo,
    session.origin?.provider,
    session.origin?.surface,
    session.origin?.label,
  ];
  return markers.some((marker) => normalizeMarker(marker) === "heartbeat");
}

export async function readTuiLastSessionKey(params: {
  scopeKey: string;
  stateDir?: string;
}): Promise<string | null> {
  const kvValue = readOpenClawStateKvJson(
    TUI_LAST_SESSION_KV_SCOPE,
    params.scopeKey,
    stateKvOptionsForStateDir(params.stateDir),
  );
  const kvRecord = normalizeLastSessionRecord(kvValue);
  if (kvRecord) {
    return kvRecord.sessionKey;
  }

  return null;
}

export async function writeTuiLastSessionKey(params: {
  scopeKey: string;
  sessionKey: string;
  stateDir?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || sessionKey === "unknown" || isHeartbeatSessionKey(sessionKey)) {
    return;
  }
  const record = {
    sessionKey,
    updatedAt: Date.now(),
  };
  writeTuiLastSessionKv({
    scopeKey: params.scopeKey,
    record,
    stateDir: params.stateDir,
  });
}

export async function clearTuiLastSessionPointers(params: {
  stateDir?: string;
  sessionKeys: ReadonlySet<string>;
}): Promise<number> {
  if (params.sessionKeys.size === 0) {
    return 0;
  }
  const removedScopeKeys = new Set<string>();
  const kvOptions = stateKvOptionsForStateDir(params.stateDir);
  for (const entry of listOpenClawStateKvJson<LastSessionRecord>(
    TUI_LAST_SESSION_KV_SCOPE,
    kvOptions,
  )) {
    const record = normalizeLastSessionRecord(entry.value);
    if (record && params.sessionKeys.has(record.sessionKey)) {
      if (deleteOpenClawStateKvJson(TUI_LAST_SESSION_KV_SCOPE, entry.key, kvOptions)) {
        removedScopeKeys.add(entry.key);
      }
    }
  }

  return removedScopeKeys.size;
}

export function resolveRememberedTuiSessionKey(params: {
  rememberedKey: string | null | undefined;
  currentAgentId: string;
  sessions: TuiSessionList["sessions"];
}): string | null {
  const rememberedKey = params.rememberedKey?.trim();
  if (!rememberedKey) {
    return null;
  }
  if (isHeartbeatSessionKey(rememberedKey)) {
    return null;
  }
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  const parsed = parseAgentSessionKey(rememberedKey);
  if (parsed && normalizeAgentId(parsed.agentId) !== currentAgentId) {
    return null;
  }
  const rememberedRest = parsed?.rest ?? rememberedKey;
  const match = params.sessions.find((session) => {
    if (isHeartbeatLikeTuiSession(session)) {
      return false;
    }
    if (session.key === rememberedKey) {
      return true;
    }
    return parseAgentSessionKey(session.key)?.rest === rememberedRest;
  });
  return match?.key ?? null;
}
