import {
  getWorkboardState,
  stopWorkboardLifecycleRefresh,
  stopWorkboardPolling,
  type WorkboardUiState,
} from "./index.ts";

export type WorkboardCapability = {
  readonly state: WorkboardUiState;
  notify: () => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

export function createWorkboardCapability(): WorkboardCapability {
  const listeners = new Set<() => void>();
  let disposed = false;
  const capability: WorkboardCapability = {
    get state() {
      return getWorkboardState(capability);
    },
    notify() {
      if (disposed) {
        return;
      }
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      stopWorkboardPolling(capability);
      stopWorkboardLifecycleRefresh(capability);
      listeners.clear();
    },
  };
  return capability;
}
