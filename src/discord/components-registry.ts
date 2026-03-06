import fs from "node:fs";
import path from "node:path";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;

const componentEntries = new Map<string, DiscordComponentEntry>();
const modalEntries = new Map<string, DiscordModalEntry>();

let registryStorePath: string | null = null;

function isExpired(entry: { expiresAt?: number }, now: number) {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= now;
}

function normalizeEntryTimestamps<T extends { createdAt?: number; expiresAt?: number }>(
  entry: T,
  now: number,
  ttlMs: number,
): T {
  const createdAt = entry.createdAt ?? now;
  const expiresAt = entry.expiresAt ?? createdAt + ttlMs;
  return { ...entry, createdAt, expiresAt };
}

function flushToDisk(): void {
  if (!registryStorePath) {
    return;
  }
  const data = {
    componentEntries: Array.from(componentEntries.values()),
    modalEntries: Array.from(modalEntries.values()),
  };
  try {
    fs.mkdirSync(path.dirname(registryStorePath), { recursive: true });
    fs.writeFileSync(registryStorePath, JSON.stringify(data), "utf8");
  } catch {
    // Best-effort persistence — do not crash the registry on write failure
  }
}

/**
 * Configure a file path for persisting the component registry across gateway restarts.
 * Pass null to disable persistence (e.g. in tests).
 */
export function setComponentRegistryStorePath(path: string | null): void {
  registryStorePath = path;
}

/**
 * Load component registry from a previously persisted store file and activate
 * persistence for future mutations.  Entries that have already expired are
 * silently discarded.  Call this once during gateway startup to restore entries
 * that survived a restart; subsequent register/consume/expire calls will then
 * flush back to the same file automatically.
 */
export function loadComponentRegistry(storePath: string): void {
  // Activate persistence so every subsequent mutation flushes to this file.
  registryStorePath = storePath;

  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch {
    // No file yet — first startup, nothing to load
    return;
  }
  let data: { componentEntries?: unknown[]; modalEntries?: unknown[] };
  try {
    data = JSON.parse(raw) as { componentEntries?: unknown[]; modalEntries?: unknown[] };
  } catch {
    // Corrupt file — skip loading, do not crash
    return;
  }
  const now = Date.now();
  const rawComponents = data.componentEntries;
  if (Array.isArray(rawComponents)) {
    for (const raw of rawComponents) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const entry = raw as DiscordComponentEntry & { expiresAt?: number };
      if (isExpired(entry, now)) {
        continue;
      }
      componentEntries.set(entry.id, entry);
    }
  }
  const rawModals = data.modalEntries;
  if (Array.isArray(rawModals)) {
    for (const raw of rawModals) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const entry = raw as DiscordModalEntry & { expiresAt?: number };
      if (isExpired(entry, now)) {
        continue;
      }
      modalEntries.set(entry.id, entry);
    }
  }
}

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): void {
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
  for (const entry of params.entries) {
    const normalized = normalizeEntryTimestamps(
      { ...entry, messageId: params.messageId ?? entry.messageId },
      now,
      ttlMs,
    );
    componentEntries.set(entry.id, normalized);
  }
  for (const modal of params.modals) {
    const normalized = normalizeEntryTimestamps(
      { ...modal, messageId: params.messageId ?? modal.messageId },
      now,
      ttlMs,
    );
    modalEntries.set(modal.id, normalized);
  }
  flushToDisk();
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  const entry = componentEntries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    componentEntries.delete(params.id);
    flushToDisk();
    return null;
  }
  if (params.consume !== false) {
    componentEntries.delete(params.id);
    flushToDisk();
  }
  return entry;
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  const entry = modalEntries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    modalEntries.delete(params.id);
    flushToDisk();
    return null;
  }
  if (params.consume !== false) {
    modalEntries.delete(params.id);
    flushToDisk();
  }
  return entry;
}

export function clearDiscordComponentEntries(): void {
  componentEntries.clear();
  modalEntries.clear();
  flushToDisk();
}
