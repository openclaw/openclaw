import { validateSessionId } from "./paths.js";
import type { SessionEntry } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    validateSessionId(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizePersistedSessionEntryShape(value: unknown): SessionEntry | undefined {
  if (!isRecord(value) || !isSafeSessionId(value.sessionId)) {
    return undefined;
  }

  let next = value as unknown as SessionEntry;
  const sessionId = value.sessionId.trim();
  if (sessionId !== value.sessionId) {
    next = { ...next, sessionId };
  }

  if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") {
    if (next === value) {
      next = { ...next };
    }
    delete next.sessionFile;
  }

  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  if (updatedAt !== value.updatedAt) {
    if (next === value) {
      next = { ...next };
    }
    next.updatedAt = updatedAt ?? 0;
  }

  return next;
}
