import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionSnapshotInvalidationReason = "cache-eviction";

export type SnapshotInvalidation =
  | { sessionKey: string; scopePrefix?: undefined; reason?: SessionSnapshotInvalidationReason }
  | { sessionKey?: undefined; scopePrefix: string; reason?: undefined }
  | { sessionKey?: undefined; scopePrefix?: undefined; reason?: undefined };

type SnapshotInvalidationListener = (invalidation: SnapshotInvalidation) => void | Promise<void>;

export function sidebarSnapshotInvalidationMatches(
  sidebarKey: string,
  { sessionKey, scopePrefix, reason }: SnapshotInvalidation,
): boolean {
  if (reason === "cache-eviction") {
    return false;
  }
  if (!sessionKey) {
    return !scopePrefix || sidebarKey.startsWith(scopePrefix);
  }
  const separator = sessionKey.indexOf("\u0000");
  // Session removal also retires its display copies; history LRU eviction does not.
  return (
    sessionKey === sidebarKey ||
    (sessionKey.startsWith("scope:[") &&
      separator >= 0 &&
      !sessionKey.slice(separator + 1).startsWith("sidebar:") &&
      sidebarKey.startsWith(sessionKey.slice(0, separator + 1)))
  );
}

const SNAPSHOT_INVALIDATION_STORAGE_KEY = "openclaw.control.chatSnapshots.invalidate.v1";
const invalidationListeners = new Set<SnapshotInvalidationListener>();
export let snapshotStoreGeneration = 0;

function notifySnapshotInvalidation(invalidation: SnapshotInvalidation): Promise<void> {
  if (!invalidation.sessionKey && !invalidation.scopePrefix) {
    snapshotStoreGeneration += 1;
  }
  return Promise.all(
    [...invalidationListeners].map((listener) => Promise.resolve(listener(invalidation))),
  ).then(() => undefined);
}

function parseSnapshotInvalidation(value: string): SnapshotInvalidation {
  try {
    const parsed = asNullableObjectRecord(JSON.parse(value));
    if (typeof parsed?.scopePrefix === "string" && parsed.scopePrefix.startsWith("scope:[")) {
      return { scopePrefix: parsed.scopePrefix };
    }
    if (typeof parsed?.sessionKey === "string" && parsed.sessionKey) {
      return {
        sessionKey: parsed.sessionKey,
        ...("reason" in parsed && parsed.reason === "cache-eviction"
          ? { reason: "cache-eviction" as const }
          : {}),
      };
    }
  } catch {}
  // Counter values from older tabs carried no scope, so they still retire every snapshot.
  return {};
}

export function publishSnapshotInvalidation(invalidation: SnapshotInvalidation): Promise<void> {
  const notified = notifySnapshotInvalidation(invalidation);
  try {
    localStorage.setItem(SNAPSHOT_INVALIDATION_STORAGE_KEY, JSON.stringify(invalidation));
    localStorage.removeItem(SNAPSHOT_INVALIDATION_STORAGE_KEY);
  } catch {}
  return notified;
}

export function subscribeSnapshotInvalidation(listener: SnapshotInvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === SNAPSHOT_INVALIDATION_STORAGE_KEY && event.newValue !== null) {
      void notifySnapshotInvalidation(parseSnapshotInvalidation(event.newValue)).catch(
        (error: unknown) => {
          console.error("[chat-snapshot-cache] cross-tab invalidation failed", error);
        },
      );
    }
  });
}
