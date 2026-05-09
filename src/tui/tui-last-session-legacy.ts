import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { writeTuiLastSessionRecordForMigration } from "./tui-last-session.js";

type LastSessionRecord = {
  sessionKey: string;
  updatedAt: number;
};

type LastSessionStore = Record<string, LastSessionRecord>;

export function resolveLegacyTuiLastSessionStatePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "tui", "last-session.json");
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
    const wrote = await writeTuiLastSessionRecordForMigration({
      scopeKey,
      sessionKey: record.sessionKey,
      updatedAt: record.updatedAt,
      stateDir: params.stateDir,
    });
    if (wrote) {
      pointers += 1;
    }
  }
  await deleteStore(filePath);
  return { imported: true, pointers };
}
