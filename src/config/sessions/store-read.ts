import fs from "node:fs";
import { isDirectorySessionStoreActive, loadSessionStoreFromDirectory } from "./store-directory.js";
import type { SessionEntry } from "./types.js";

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry | undefined> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readSessionStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry | undefined> {
  if (isDirectorySessionStoreActive(storePath)) {
    return loadSessionStoreFromDirectory({ storePath }).store;
  }
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return isSessionStoreRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
