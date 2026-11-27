import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

type SessionTitleTarget = {
  storePath: string;
  sessionKey: string;
  sessionId: string;
};
function requestKey(target: SessionTitleTarget) {
  // Chat admits the standard logical sessions.json; row readers already hold its SQLite path.
  // A custom logical store may resolve to a suffixed database. Never guess that identity.
  const resolved = target.storePath.endsWith(".sqlite")
    ? undefined
    : resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath);
  const storePath = resolved?.agentId ? resolved.path : target.storePath;
  return `${storePath}\0${target.sessionKey}\0${target.sessionId}`;
}

// One request per session; callers share settlement and pending requests
// always leave the registry, including model failures and timeouts.
const pending = new Map<string, { request: Promise<boolean>; started: boolean }>();
// Creation publishes its row before the first input reaches the naming owner.
const creating = new Set<string>();
export const sessionTitleRequests = {
  holdCreation(target: SessionTitleTarget) {
    const key = requestKey(target);
    creating.add(key);
    return () => creating.delete(key);
  },
  get(target: SessionTitleTarget) {
    return pending.get(requestKey(target))?.request;
  },
  isPending(target: SessionTitleTarget) {
    if (!creating.size && !pending.size) {
      return false;
    }
    const key = requestKey(target);
    return creating.has(key) || pending.get(key)?.started === true;
  },
  run(
    target: SessionTitleTarget,
    create: (markStarted: () => void) => Promise<boolean>,
    onStateChanged?: () => void,
  ) {
    const key = requestKey(target);
    const existing = pending.get(key);
    if (existing) {
      return existing.request;
    }
    const request = Promise.resolve().then(() =>
      create(() => {
        owner.started = true;
        onStateChanged?.();
      }),
    );
    const owner = { request, started: creating.delete(key) };
    pending.set(key, owner);
    const settle = () => {
      pending.delete(key);
      if (owner.started) {
        onStateChanged?.();
      }
    };
    void request.then(settle, settle);
    return request;
  },
};

/** An initial title owns the placeholder until either its name or its fallback has been read. */
export function isTitlePending(record: {
  entry: Pick<SessionEntry, "titleFallbackReady" | "sessionId" | "displayName" | "label">;
  fallbackTitle?: string | null;
  key: string;
  materialized: { row: { hasMessages?: boolean; derivedTitle?: string } };
  preparedPrivate?: object;
  storeTarget: { storePath: string };
}): boolean {
  if (record.entry.titleFallbackReady) {
    return (
      !record.preparedPrivate &&
      record.materialized.row.hasMessages === true &&
      record.fallbackTitle === undefined &&
      !record.materialized.row.derivedTitle &&
      !record.entry.displayName &&
      !record.entry.label
    );
  }
  return sessionTitleRequests.isPending({
    storePath: record.storeTarget.storePath,
    sessionKey: record.key,
    sessionId: record.entry.sessionId,
  });
}

export function resolveExplicitSessionName(entry: SessionEntry | undefined): string | undefined {
  const label = entry?.label?.trim();
  if (label) {
    return label;
  }
  // autoLabel is device metadata and must not block generated displayName titles.
  return [entry?.displayName, entry?.subject, entry?.groupChannel, entry?.space]
    .map((value) => value?.trim())
    .find(Boolean);
}

export function hasExplicitSessionName(entry: SessionEntry | undefined): boolean {
  return Boolean(resolveExplicitSessionName(entry));
}
