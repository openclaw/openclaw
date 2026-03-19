import type { SessionManager } from "@mariozechner/pi-coding-agent";

type SessionTimestampInput = Date | number | string;

type SessionEntryLike = {
  timestamp?: unknown;
  type?: string;
};

type MutableSessionManager = SessionManager & {
  flushed?: boolean;
  fileEntries?: SessionEntryLike[];
  _appendEntry?: (entry: SessionEntryLike) => unknown;
  _rewriteFile?: () => void;
  createBranchedSession?: (leafId?: string | null) => string | undefined;
};

const SESSION_MANAGER_WRAPPED = Symbol("openclaw.session-manager-local-timestamps");
const NORMALIZE_ON_REWRITE = Symbol("openclaw.session-manager-normalize-on-rewrite");
const HEADER_NORMALIZED = Symbol("openclaw.session-manager-header-normalized");

type MutableSessionManagerWithFlags = MutableSessionManager & {
  [SESSION_MANAGER_WRAPPED]?: boolean;
  [NORMALIZE_ON_REWRITE]?: boolean;
  [HEADER_NORMALIZED]?: boolean;
};

function toDate(value: SessionTimestampInput): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid session timestamp: ${String(value)}`);
  }
  return date;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function formatLocalSessionTimestamp(value: SessionTimestampInput = new Date()): string {
  const date = toDate(value);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`
  );
}

function normalizeEntryTimestamp(entry: SessionEntryLike | undefined): void {
  if (!entry) {
    return;
  }
  const value = entry.timestamp;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return;
  }
  entry.timestamp = formatLocalSessionTimestamp(value);
}

function normalizePendingHeader(sessionManager: MutableSessionManagerWithFlags): void {
  if (sessionManager.flushed || sessionManager[HEADER_NORMALIZED]) {
    return;
  }
  const header = sessionManager.fileEntries?.find((entry) => entry?.type === "session");
  normalizeEntryTimestamp(header);
  sessionManager[HEADER_NORMALIZED] = true;
}

function normalizeAllEntries(sessionManager: MutableSessionManagerWithFlags): void {
  sessionManager.fileEntries?.forEach((entry) => normalizeEntryTimestamp(entry));
}

export function wrapSessionManagerWithLocalTimestamps(
  sessionManager: SessionManager,
): SessionManager {
  const mutableSessionManager = sessionManager as MutableSessionManagerWithFlags;
  if (mutableSessionManager[SESSION_MANAGER_WRAPPED]) {
    return sessionManager;
  }
  mutableSessionManager[SESSION_MANAGER_WRAPPED] = true;

  // Normalize any header already written during SessionManager.open() recovery
  normalizePendingHeader(mutableSessionManager);

  const originalAppendEntry = mutableSessionManager._appendEntry?.bind(mutableSessionManager);
  if (originalAppendEntry) {
    mutableSessionManager._appendEntry = ((entry: SessionEntryLike) => {
      normalizePendingHeader(mutableSessionManager);
      normalizeEntryTimestamp(entry);
      return originalAppendEntry(entry);
    }) as typeof mutableSessionManager._appendEntry;
  } else {
    console.warn(
      "[openclaw] wrapSessionManagerWithLocalTimestamps: _appendEntry not found — local timestamp normalisation is a no-op",
    );
  }

  const originalRewriteFile = mutableSessionManager._rewriteFile?.bind(mutableSessionManager);
  if (originalRewriteFile) {
    mutableSessionManager._rewriteFile = (() => {
      if (mutableSessionManager[NORMALIZE_ON_REWRITE]) {
        normalizeAllEntries(mutableSessionManager);
      }
      return originalRewriteFile();
    }) as typeof mutableSessionManager._rewriteFile;
  } else {
    console.warn(
      "[openclaw] wrapSessionManagerWithLocalTimestamps: _rewriteFile not found — rewrite-time normalisation is a no-op",
    );
  }

  const originalCreateBranchedSession =
    mutableSessionManager.createBranchedSession?.bind(mutableSessionManager);
  if (originalCreateBranchedSession) {
    mutableSessionManager.createBranchedSession = ((leafId?: string | null) => {
      mutableSessionManager[NORMALIZE_ON_REWRITE] = true;
      normalizeAllEntries(mutableSessionManager);
      mutableSessionManager[HEADER_NORMALIZED] = false;
      try {
        return originalCreateBranchedSession(leafId);
      } finally {
        mutableSessionManager[NORMALIZE_ON_REWRITE] = false;
      }
    }) as typeof mutableSessionManager.createBranchedSession;
  }

  return sessionManager;
}
