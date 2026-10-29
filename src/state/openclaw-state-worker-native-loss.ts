import { isSqliteWorkerStoreAvailable } from "../infra/sqlite-worker-store.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { Entry } from "./openclaw-state-worker-store.types.js";

export function createNotifier(listeners: Set<() => void>): () => void {
  return notifyListeners.bind(undefined, listeners, undefined);
}

export function retainListener(
  entry: Pick<Entry, "nativeLostListeners" | "store">,
  onNativeLost?: () => void,
): (() => void) | undefined {
  if (!onNativeLost) {
    return undefined;
  }
  const release = registerListener(entry.nativeLostListeners, onNativeLost);
  if (!entry.store || !isSqliteWorkerStoreAvailable(entry.store)) {
    onNativeLost();
  }
  return release;
}
