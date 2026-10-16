import type { Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

export type UpdateSessionEntry =
  typeof import("../config/sessions/session-accessor.js").patchSessionEntryTarget;
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
  params: { sessionKey: string; entry: SessionEntry; event: LifecycleEvent },
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
      const [, update] = args;
      const patch = await update(structuredClone(currentEntry), {
        existingEntry: structuredClone(currentEntry),
      });
      if (patch) {
        currentEntry = { ...currentEntry, ...patch };
      }
      return currentEntry;
    });
  await persistGatewaySessionLifecycleEvent({ sessionKey: params.sessionKey, event: params.event });
  return currentEntry;
}
