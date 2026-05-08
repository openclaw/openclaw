import { createHash } from "node:crypto";
import path from "node:path";
import {
  createPluginStateKeyedStore,
  type PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";

export const MEMORY_CORE_PLUGIN_ID = "memory-core";
const MAX_DREAMING_STATE_ROWS = 200_000;
const WORKSPACE_HASH_BYTES = 24;
export const MEMORY_CORE_DAILY_INGESTION_STATE_NAMESPACE = "dreaming.daily-ingestion";
export const MEMORY_CORE_SESSION_INGESTION_FILES_NAMESPACE = "dreaming.session-ingestion.files";
export const MEMORY_CORE_SESSION_INGESTION_MESSAGES_NAMESPACE =
  "dreaming.session-ingestion.messages";
export const MEMORY_CORE_SHORT_TERM_RECALL_NAMESPACE = "dreaming.short-term-recall";
export const MEMORY_CORE_SHORT_TERM_PHASE_SIGNAL_NAMESPACE = "dreaming.phase-signals";
export const MEMORY_CORE_SHORT_TERM_META_NAMESPACE = "dreaming.short-term-meta";

type WorkspaceMapRow<T> = {
  workspaceKey: string;
  key: string;
  value: T;
};

type WorkspaceValueRow<T> = {
  workspaceKey: string;
  value: T;
};

const stores = new Map<string, PluginStateKeyedStore<unknown>>();

function getStore<T>(namespace: string): PluginStateKeyedStore<T> {
  const existing = stores.get(namespace);
  if (existing) {
    return existing as PluginStateKeyedStore<T>;
  }
  const store = createPluginStateKeyedStore<T>(MEMORY_CORE_PLUGIN_ID, {
    namespace,
    maxEntries: MAX_DREAMING_STATE_ROWS,
  });
  stores.set(namespace, store as PluginStateKeyedStore<unknown>);
  return store;
}

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hashValue(value: string, bytes = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, bytes);
}

function workspacePrefix(workspaceDir: string): { prefix: string; workspaceKey: string } {
  const workspaceKey = normalizeWorkspaceKey(workspaceDir);
  return {
    prefix: hashValue(workspaceKey, WORKSPACE_HASH_BYTES),
    workspaceKey,
  };
}

function mapEntryKey(workspaceDir: string, key: string): string {
  const { prefix } = workspacePrefix(workspaceDir);
  return `${prefix}:${hashValue(key)}`;
}

function valueEntryKey(workspaceDir: string, key: string): string {
  const { prefix } = workspacePrefix(workspaceDir);
  return `${prefix}:${key}`;
}

export function createDreamingWorkspaceMapStorageEntry<T>(
  workspaceDir: string,
  key: string,
  value: T,
): { key: string; value: WorkspaceMapRow<T> } {
  const { workspaceKey } = workspacePrefix(workspaceDir);
  return {
    key: mapEntryKey(workspaceDir, key),
    value: { workspaceKey, key, value },
  };
}

export function createDreamingWorkspaceValueStorageEntry<T>(
  workspaceDir: string,
  key: string,
  value: T,
): { key: string; value: WorkspaceValueRow<T> } {
  const { workspaceKey } = workspacePrefix(workspaceDir);
  return {
    key: valueEntryKey(workspaceDir, key),
    value: { workspaceKey, value },
  };
}

export async function readDreamingWorkspaceMap<T>(
  namespace: string,
  workspaceDir: string,
): Promise<Record<string, T>> {
  const { prefix, workspaceKey } = workspacePrefix(workspaceDir);
  const rows = await getStore<WorkspaceMapRow<T>>(namespace).entries();
  const map: Record<string, T> = {};
  for (const row of rows) {
    if (!row.key.startsWith(`${prefix}:`) || row.value.workspaceKey !== workspaceKey) {
      continue;
    }
    map[row.value.key] = row.value.value;
  }
  return map;
}

export async function writeDreamingWorkspaceMap<T>(
  namespace: string,
  workspaceDir: string,
  values: Record<string, T>,
): Promise<void> {
  const store = getStore<WorkspaceMapRow<T>>(namespace);
  const { prefix, workspaceKey } = workspacePrefix(workspaceDir);
  const nextKeys = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    const entry = createDreamingWorkspaceMapStorageEntry(workspaceDir, key, value);
    nextKeys.add(entry.key);
    await store.register(entry.key, entry.value);
  }
  const existing = await store.entries();
  await Promise.all(
    existing
      .filter((row) => row.key.startsWith(`${prefix}:`) && row.value.workspaceKey === workspaceKey)
      .filter((row) => !nextKeys.has(row.key))
      .map((row) => store.delete(row.key)),
  );
}

export async function readDreamingWorkspaceValue<T>(
  namespace: string,
  workspaceDir: string,
  key: string,
): Promise<T | undefined> {
  const { workspaceKey } = workspacePrefix(workspaceDir);
  const row = await getStore<WorkspaceValueRow<T>>(namespace).lookup(
    valueEntryKey(workspaceDir, key),
  );
  if (!row || row.workspaceKey !== workspaceKey) {
    return undefined;
  }
  return row.value;
}

export async function writeDreamingWorkspaceValue(
  namespace: string,
  workspaceDir: string,
  key: string,
  value: unknown,
): Promise<void> {
  const entry = createDreamingWorkspaceValueStorageEntry(workspaceDir, key, value);
  await getStore<WorkspaceValueRow<unknown>>(namespace).register(entry.key, entry.value);
}
