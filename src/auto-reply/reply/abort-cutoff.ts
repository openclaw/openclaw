import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";

export type AbortCutoff = {
  messageSid?: string;
  timestamp?: number;
};

type SessionAbortCutoffEntry = Pick<SessionEntry, "abortCutoffMessageSid" | "abortCutoffTimestamp">;

export function resolveAbortCutoffFromContext(ctx: MsgContext): AbortCutoff | undefined {
  const messageSid =
    (typeof ctx.MessageSidFull === "string" && ctx.MessageSidFull.trim()) ||
    (typeof ctx.MessageSid === "string" && ctx.MessageSid.trim()) ||
    undefined;
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  if (!messageSid && timestamp === undefined) {
    return undefined;
  }
  return { messageSid, timestamp };
}

export function readAbortCutoffFromSessionEntry(
  entry: SessionAbortCutoffEntry | undefined,
): AbortCutoff | undefined {
  if (!entry) {
    return undefined;
  }
  const messageSid = entry.abortCutoffMessageSid?.trim() || undefined;
  const timestamp =
    typeof entry.abortCutoffTimestamp === "number" && Number.isFinite(entry.abortCutoffTimestamp)
      ? entry.abortCutoffTimestamp
      : undefined;
  if (!messageSid && timestamp === undefined) {
    return undefined;
  }
  return { messageSid, timestamp };
}

export function hasAbortCutoff(entry: SessionAbortCutoffEntry | undefined): boolean {
  return readAbortCutoffFromSessionEntry(entry) !== undefined;
}

export function applyAbortCutoffToSessionEntry(
  entry: SessionAbortCutoffEntry,
  cutoff: AbortCutoff | undefined,
): void {
  entry.abortCutoffMessageSid = cutoff?.messageSid;
  entry.abortCutoffTimestamp = cutoff?.timestamp;
}

export async function clearAbortCutoffInSession(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<boolean> {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) {
    return false;
  }

  applyAbortCutoffToSessionEntry(sessionEntry, undefined);
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;

  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      const existing = store[sessionKey] ?? sessionEntry;
      if (!existing) {
        return;
      }
      applyAbortCutoffToSessionEntry(existing, undefined);
      existing.updatedAt = Date.now();
      store[sessionKey] = existing;
    });
  }

  return true;
}

function toNumericMessageSid(value: string | undefined): bigint | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return undefined;
  }
}

export function shouldSkipMessageByAbortCutoff(params: {
  cutoffMessageSid?: string;
  cutoffTimestamp?: number;
  messageSid?: string;
  timestamp?: number;
}): boolean {
  const cutoffSid = params.cutoffMessageSid?.trim();
  const currentSid = params.messageSid?.trim();
  if (cutoffSid && currentSid) {
    const cutoffNumeric = toNumericMessageSid(cutoffSid);
    const currentNumeric = toNumericMessageSid(currentSid);
    if (cutoffNumeric !== undefined && currentNumeric !== undefined) {
      return currentNumeric <= cutoffNumeric;
    }
    if (currentSid === cutoffSid) {
      return true;
    }
  }
  if (
    typeof params.cutoffTimestamp === "number" &&
    Number.isFinite(params.cutoffTimestamp) &&
    typeof params.timestamp === "number" &&
    Number.isFinite(params.timestamp)
  ) {
    return params.timestamp <= params.cutoffTimestamp;
  }
  return false;
}

export function shouldPersistAbortCutoff(params: {
  commandSessionKey?: string;
  targetSessionKey?: string;
}): boolean {
  const commandSessionKey = params.commandSessionKey?.trim();
  const targetSessionKey = params.targetSessionKey?.trim();
  if (!commandSessionKey || !targetSessionKey) {
    return true;
  }
  // Native targeted /stop can run from a slash/session-control key while the
  // actual target session uses different message id/timestamp spaces.
  // Persist cutoff only when command source and target are the same session.
  return commandSessionKey === targetSessionKey;
}
