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
  fileEntries?: SessionManagerTailEntry[];
  byId?: Map<string, unknown>;
  leafId?: string | null;
  _rewriteFile?: () => void;
};

export function removeSessionManagerTailEntries(
  sessionManager: unknown,
  shouldRemove: (entry: SessionManagerTailEntry) => boolean,
  options: { maxEntries?: number; minEntries?: number } = {},
): RemoveSessionManagerTailResult {
  const mutable = sessionManager as MutableSessionManagerTail | undefined;
  const fileEntries = mutable?.fileEntries;
  const byId = mutable?.byId;
  if (!Array.isArray(fileEntries) || !(byId instanceof Map)) {
    return { removed: 0, unavailable: true, rewriteUnavailable: false };
  }
  if (typeof mutable?._rewriteFile !== "function") {
    return { removed: 0, unavailable: false, rewriteUnavailable: true };
  }

  const minEntries = options.minEntries ?? 0;
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  let removed = 0;
  while (fileEntries.length > minEntries && removed < maxEntries) {
    const last = fileEntries.at(-1);
    if (!last || !shouldRemove(last)) {
      break;
    }
    fileEntries.pop();
    if (last.id) {
      byId.delete(last.id);
    }
    mutable.leafId = last.parentId ?? null;
    removed += 1;
  }

  if (removed > 0) {
    mutable._rewriteFile();
  }
  return { removed, unavailable: false, rewriteUnavailable: false };
}
