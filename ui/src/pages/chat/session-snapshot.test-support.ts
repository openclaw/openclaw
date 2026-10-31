import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";

// Measure caller admission separately from spies on the store's deferred projection.
const stringifyFixture = JSON.stringify;

export function writeSnapshotFixture(
  store: SessionSnapshotStore,
  key: string,
  snapshot: ChatSessionSnapshot,
): void {
  let weight = 0;
  try {
    weight = stringifyFixture(snapshot).length;
  } catch {
    // Malformed fixtures intentionally reach the store's projection-rejection path.
  }
  store.write(key, snapshot, weight);
}
