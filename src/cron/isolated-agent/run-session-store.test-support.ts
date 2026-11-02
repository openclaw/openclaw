import type { SessionEntry } from "../../config/sessions.js";
import { mergeSessionEntryPatch } from "../../config/sessions/session-entry-patch-operation.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";

type SessionAccessorModule = typeof import("../../config/sessions/session-accessor.js");

export function usesRealAccessorStore(storePath?: string): boolean {
  return Boolean(storePath && storePath !== "/tmp/store.json");
}

/**
 * In-memory stand-in for the SQLite accessor `patchSessionEntryCore` used by the
 * cron persist path. Prod flips real session storage to per-agent SQLite, but
 * these orchestration tests must stay off disk. The store keys on
 * storePath+sessionKey so successive persists in one run observe the row the
 * previous persist committed, mirroring the accessor's read-modify-write and
 * letting the lifecycle claim guard prove ownership without real SQLite.
 */
export function createSessionEntryPatchStore(
  loadSessionEntry: (storePath: string | undefined, sessionKey: string) => SessionEntry | undefined,
  replaceSessionEntry: SessionAccessorModule["replaceSessionEntry"],
): SessionAccessorModule["patchSessionEntryCore"] {
  const rows = new Map<string, SessionEntry>();
  return async (
    ...[scope, update, options = {}]: Parameters<SessionAccessorModule["patchSessionEntryCore"]>
  ) => {
    const key = `${scope.storePath ?? ""}\\0${scope.sessionKey}`;
    const existingEntry =
      rows.get(key) ??
      (usesRealAccessorStore(scope.storePath)
        ? await readSessionEntryReadOnlyInWorker(scope)
        : loadSessionEntry(scope.storePath, scope.sessionKey));
    const writeBase = existingEntry ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(structuredClone(writeBase), {
      existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
    });
    // Partial auth updates must preserve session identity just like the real accessor.
    const committed = mergeSessionEntryPatch({
      existing: existingEntry,
      writeBase,
      patch,
      sessionKey: scope.sessionKey,
      replaceEntry: options.replaceEntry,
      preserveActivity: options.preserveActivity,
    });
    if (!committed) {
      return structuredClone(writeBase);
    }
    rows.set(key, committed);
    if (usesRealAccessorStore(scope.storePath)) {
      await replaceSessionEntry(scope, committed);
    }
    return committed;
  };
}
