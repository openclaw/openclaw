import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type IntegrityActor = "cli" | "gateway" | "manual" | "migration";

export type ConfigIntegrityEntry = {
  hash: string;
  updatedAt: number;
  updatedBy: IntegrityActor;
  fileSize: number;
};

export type ConfigIntegrityAuditEntry = {
  ts: number;
  file: string;
  action: "created" | "updated" | "verified-ok" | "tampered" | "removed";
  hash: string;
  actor: IntegrityActor;
};

export type ConfigIntegrityStore = {
  version: 1;
  entries: Record<string, ConfigIntegrityEntry>;
  auditLog: ConfigIntegrityAuditEntry[];
};

const STORE_FILENAME = "config-integrity.json";
const IDENTITY_DIR = "identity";
const MAX_AUDIT_LOG_ENTRIES = 1000;

function resolveStorePath(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, IDENTITY_DIR, STORE_FILENAME);
}

function emptyStore(): ConfigIntegrityStore {
  return { version: 1, entries: {}, auditLog: [] };
}

export function loadConfigIntegrityStore(stateDir?: string): ConfigIntegrityStore {
  const storePath = resolveStorePath(stateDir);
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as ConfigIntegrityStore;
    if (
      parsed.version !== 1 ||
      typeof parsed.entries !== "object" ||
      !Array.isArray(parsed.auditLog)
    ) {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

export function saveConfigIntegrityStore(store: ConfigIntegrityStore, stateDir?: string): void {
  const storePath = resolveStorePath(stateDir);
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(storePath, json, { encoding: "utf-8", mode: 0o600 });
}

export function addAuditEntry(
  store: ConfigIntegrityStore,
  entry: Omit<ConfigIntegrityAuditEntry, "ts">,
): ConfigIntegrityStore {
  const fullEntry: ConfigIntegrityAuditEntry = { ts: Date.now(), ...entry };
  const auditLog = [...store.auditLog, fullEntry];
  // Cap at MAX_AUDIT_LOG_ENTRIES (FIFO)
  const trimmed =
    auditLog.length > MAX_AUDIT_LOG_ENTRIES ? auditLog.slice(-MAX_AUDIT_LOG_ENTRIES) : auditLog;
  return { ...store, auditLog: trimmed };
}

export function resolveIntegrityStorePath(stateDir?: string): string {
  return resolveStorePath(stateDir);
}
