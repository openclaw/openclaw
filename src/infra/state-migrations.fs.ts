// Filesystem primitives used by legacy state migration code.
import fs from "node:fs";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

/** Minimal session-store entry shape needed by state migration ordering and repair logic. */
export type SessionEntryLike = {
  sessionId?: string;
  updatedAt?: number;
} & Record<string, unknown>;

/** Reads a session store from disk, accepting JSON first and JSON5 as legacy/operator input. */
export function readSessionStoreJson5(storePath: string): {
  store: Record<string, SessionEntryLike>;
  ok: boolean;
} {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    return parseSessionStoreJson5(raw);
  } catch {
    // ignore
  }
  return { store: {}, ok: false };
}

/** Parses session-store text, preferring strict JSON before JSON5 compatibility. */
export function parseSessionStoreJson5(raw: string): {
  store: Record<string, SessionEntryLike>;
  ok: boolean;
} {
  try {
    const parsed = parseJsonWithJson5Fallback(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { store: parsed as Record<string, SessionEntryLike>, ok: true };
    }
  } catch {
    // ignore
  }
  return { store: {}, ok: false };
}
