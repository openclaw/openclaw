import type { patchSessionEntryTarget } from "../../config/sessions/session-accessor.js";
import type { ResetSessionEntryLifecycleMutation } from "../../config/sessions/session-accessor.lifecycle-types.js";
import type { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.lifecycle.js";

export function createSessionResetFixture(
  patchEntry: typeof patchSessionEntryTarget,
): typeof resetSessionEntryLifecycle {
  return async (params) => {
    let mutation: ResetSessionEntryLifecycleMutation | undefined;
    await patchEntry(
      { agentId: params.agentId, storePath: params.storePath, target: params.target },
      async (_entry, { existingEntry: previousEntry }) => {
        params.commitGuard?.();
        const nextEntry = await params.buildNextEntry({
          currentEntry: previousEntry ? structuredClone(previousEntry) : undefined,
          primaryKey: params.target.canonicalKey,
        });
        params.commitGuard?.();
        mutation = { nextEntry, previousEntry, previousSessionId: previousEntry?.sessionId };
        return nextEntry;
      },
      {
        // The accessor needs a creation seed; buildNextEntry sees only the actual prior row.
        fallbackEntry: { sessionId: "", updatedAt: 0 },
        replaceEntry: true,
        assertCommitAllowed: params.commitGuard,
      },
    );
    if (!mutation) {
      throw new Error("Reset fixture did not commit a session entry");
    }
    await params.afterEntryMutation?.(mutation, {
      env: {},
      source: { agentId: params.agentId ?? "main", path: params.storePath },
      assertCurrent: () => params.commitGuard?.(),
    });
    return { ...mutation, archivedTranscripts: [] };
  };
}
