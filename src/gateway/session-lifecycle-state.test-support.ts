import type { Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { projectSessionEntryPatch } from "../config/sessions/session-entry-patch-operation.js";
import type { SessionLifecyclePatchEffects } from "../config/sessions/session-run-lifecycle-projection.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

export type UpdateSessionEntry =
  typeof import("../config/sessions/session-accessor.sqlite-entry.js").applySessionEntryTargetOperation;
export type LifecycleEvent = Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"];

/** Records prepared work before the persistence owner invokes its callback. */
export function createPreparedLifecycleWriteTracker() {
  const accepted = createDeferred();
  const writes: Promise<void>[] = [];
  return {
    accepted: accepted.promise,
    track(persist: () => Promise<void>) {
      const settled = createDeferred();
      writes.push(settled.promise);
      // Observe early rejection while retaining it for drain's error propagation.
      settled.promise.catch(() => undefined);
      accepted.resolve();
      return async () => {
        try {
          await persist();
          settled.resolve();
        } catch (error) {
          settled.reject(error);
          throw error;
        }
      };
    },
    async drain(...owners: Promise<void>[]) {
      let acceptedCount: number;
      do {
        acceptedCount = writes.length;
        await Promise.allSettled([...owners, ...writes]);
      } while (writes.length !== acceptedCount);
      await Promise.all([...owners, ...writes]);
    },
  };
}

/** Persists one lifecycle event against an in-memory row served by the test file's store mocks. */
export async function persistLifecycleThroughMockedStore(
  mocks: { loadSessionEntry: Mock; updateSessionEntry: Mock },
  params: { sessionKey: string; entry: SessionEntry; event: LifecycleEvent; clientRunId?: string },
): Promise<SessionEntry> {
  let currentEntry = structuredClone(params.entry);
  mocks.loadSessionEntry.mockReset().mockReturnValue({
    storePath: "/tmp/sessions.json",
    canonicalKey: params.sessionKey,
    storeKeys: [params.sessionKey],
    entry: currentEntry,
  });
  mocks.updateSessionEntry
    .mockReset()
    .mockImplementation(async (...args: Parameters<UpdateSessionEntry>) => {
      const [, operation, options] = args;
      let effects: SessionLifecyclePatchEffects | undefined;
      const next = projectSessionEntryPatch({
        existing: currentEntry,
        writeBase: currentEntry,
        sessionKey: params.sessionKey,
        operation,
        onLifecycleProjection: (value) => {
          effects = value;
        },
      });
      if (next) {
        currentEntry = next;
        options?.onCommitted?.(currentEntry, undefined, effects);
      }
      return currentEntry;
    });
  await persistGatewaySessionLifecycleEvent({
    sessionKey: params.sessionKey,
    event: params.event,
    clientRunId: params.clientRunId,
  });
  return currentEntry;
}
