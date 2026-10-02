import type { Mock } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

export type UpdateSessionEntry =
  typeof import("../config/sessions/session-accessor.js").patchSessionEntryCore;
export type LifecycleEvent = Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"];

/** Persists one lifecycle event against an in-memory row served by the test file's store mocks. */
export async function persistLifecycleThroughMockedStore(
  mocks: { loadSessionEntry: Mock; updateSessionEntry: Mock },
  params: { sessionKey: string; entry: SessionEntry; event: LifecycleEvent },
): Promise<SessionEntry> {
  let currentEntry = structuredClone(params.entry);
  mocks.loadSessionEntry.mockReset().mockReturnValue({
    storePath: "/tmp/sessions.json",
    canonicalKey: params.sessionKey,
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
