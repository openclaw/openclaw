export type SessionManagerTailEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: unknown;
  customType?: string;
};

export type RemoveSessionManagerTailResult = {
  removed: number;
  unavailable: boolean;
  rewriteUnavailable: boolean;
};

type MutableSessionManagerTail = {
  removeTailEntries?: (
    shouldRemove: (entry: SessionManagerTailEntry) => boolean,
    options?: { maxEntries?: number; minEntries?: number },
  ) => number;
};

export function removeSessionManagerTailEntries(
  sessionManager: unknown,
  shouldRemove: (entry: SessionManagerTailEntry) => boolean,
  options: { maxEntries?: number; minEntries?: number } = {},
): RemoveSessionManagerTailResult {
  const mutable = sessionManager as MutableSessionManagerTail | undefined;
  if (typeof mutable?.removeTailEntries !== "function") {
    return { removed: 0, unavailable: true, rewriteUnavailable: false };
  }
  const removed = mutable.removeTailEntries(shouldRemove, options);
  return { removed, unavailable: false, rewriteUnavailable: false };
}
