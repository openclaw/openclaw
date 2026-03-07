import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const DEFAULT_COMPONENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache mirrors the file to avoid reading on every resolve.
let componentEntries = new Map<string, DiscordComponentEntry>();
let modalEntries = new Map<string, DiscordModalEntry>();
let cacheLoaded = false;

const REGISTRY_DIR = path.join(STATE_DIR, "discord");
const REGISTRY_PATH = path.join(REGISTRY_DIR, "component-registry.json");

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

type RegistryFile = {
  components: Record<string, DiscordComponentEntry>;
  modals: Record<string, DiscordModalEntry>;
};

function loadFromFile(): {
  components: Map<string, DiscordComponentEntry>;
  modals: Map<string, DiscordModalEntry>;
} {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
    const parsed: RegistryFile = JSON.parse(raw);
    const components = new Map(Object.entries(parsed.components ?? {}));
    const modals = new Map(Object.entries(parsed.modals ?? {}));
    return { components, modals };
  } catch {
    // ENOENT or corrupt file — start fresh.
    return { components: new Map(), modals: new Map() };
  }
}

function saveToFile(): void {
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const data: RegistryFile = {
      components: Object.fromEntries(componentEntries),
      modals: Object.fromEntries(modalEntries),
    };
    const json = JSON.stringify(data, null, 2);
    const tmp = `${REGISTRY_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json, "utf-8");
    fs.renameSync(tmp, REGISTRY_PATH);
  } catch {
    // Best-effort — don't crash the bot if disk write fails.
  }
}

function ensureLoaded(): void {
  if (cacheLoaded) {
    return;
  }
  const loaded = loadFromFile();
  // Merge file entries into any in-memory entries (in case register was
  // called before the first resolve in this process).
  for (const [id, entry] of loaded.components) {
    if (!componentEntries.has(id)) {
      componentEntries.set(id, entry);
    }
  }
  for (const [id, entry] of loaded.modals) {
    if (!modalEntries.has(id)) {
      modalEntries.set(id, entry);
    }
  }
  cacheLoaded = true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API (unchanged signatures)
// ---------------------------------------------------------------------------

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): void {
  ensureLoaded();
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
  saveToFile();
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  ensureLoaded();
  const entry = componentEntries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    componentEntries.delete(params.id);
    saveToFile();
    return null;
  }
  if (params.consume !== false) {
    componentEntries.delete(params.id);
    saveToFile();
  }
  return entry;
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  ensureLoaded();
  const entry = modalEntries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    modalEntries.delete(params.id);
    saveToFile();
    return null;
  }
  if (params.consume !== false) {
    modalEntries.delete(params.id);
    saveToFile();
  }
  return entry;
}

export function clearDiscordComponentEntries(): void {
  componentEntries.clear();
  modalEntries.clear();
  cacheLoaded = false;
  try {
    fs.unlinkSync(REGISTRY_PATH);
  } catch {
    // File may not exist.
  }
}
