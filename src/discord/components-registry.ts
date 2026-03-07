import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;

const COMPONENT_KEY = "__openclaw_discord_component_entries";
const MODAL_KEY = "__openclaw_discord_modal_entries";

// Use globalThis singletons so every bundle chunk shares the same Map.
// Without this, the build can produce multiple copies of this module in
// different output chunks, each with its own module-scoped Map.  The send
// path registers entries in one Map while the interaction handler looks
// them up in another, causing buttons to appear "expired" immediately.
function getComponentEntries(): Map<string, DiscordComponentEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[COMPONENT_KEY]) {
    g[COMPONENT_KEY] = new Map<string, DiscordComponentEntry>();
  }
  return g[COMPONENT_KEY] as Map<string, DiscordComponentEntry>;
}

function getModalEntries(): Map<string, DiscordModalEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[MODAL_KEY]) {
    g[MODAL_KEY] = new Map<string, DiscordModalEntry>();
  }
  return g[MODAL_KEY] as Map<string, DiscordModalEntry>;
}

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
    getComponentEntries().set(entry.id, normalized);
  }
  for (const modal of params.modals) {
    const normalized = normalizeEntryTimestamps(
      { ...modal, messageId: params.messageId ?? modal.messageId },
      now,
      ttlMs,
    );
    getModalEntries().set(modal.id, normalized);
  }
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  const entries = getComponentEntries();
  const entry = entries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    entries.delete(params.id);
    return null;
  }
  if (params.consume !== false) {
    entries.delete(params.id);
  }
  return entry;
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  const modals = getModalEntries();
  const entry = modals.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    modals.delete(params.id);
    return null;
  }
  if (params.consume !== false) {
    modals.delete(params.id);
  }
  return entry;
}

export function clearDiscordComponentEntries(): void {
  getComponentEntries().clear();
  getModalEntries().clear();
}
