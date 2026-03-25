import fs from "node:fs";
import type { SessionEntry } from "./types.js";

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry | undefined> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readSessionStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry | undefined> {
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
