import type { SessionEntry } from "./types.js";

export function applySessionStoreMigrations(store: Record<string, SessionEntry>): void {
  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }
  }

  // Migrate legacy `:dm:` store keys → `:direct:` (all channels).
  migrateLegacyDmStoreKeys(store);
}

function migrateLegacyDmStoreKeys(store: Record<string, SessionEntry>): void {
  for (const key of Object.keys(store)) {
    if (!key.toLowerCase().includes(":dm:")) {
      continue;
    }
    // Replace :dm: (case-insensitive) with :direct: and lowercase the entire key.
    const newKey = key.toLowerCase().replace(/:dm:/g, ":direct:");
    const oldEntry = store[key];
    const existingEntry = store[newKey];
    if (!oldEntry) {
      continue;
    }
    if (existingEntry) {
      // Both keys exist — keep the most recently updated entry.
      const oldTime = oldEntry.updatedAt ?? 0;
      const newTime = existingEntry.updatedAt ?? 0;
      if (oldTime > newTime) {
        store[newKey] = oldEntry;
      }
    } else {
      store[newKey] = oldEntry;
    }
    delete store[key];
  }
}
