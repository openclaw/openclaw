/**
 * Generic active-dispatch tracker with reference counting.
 *
 * Tracks how many concurrent dispatches are in progress for a given key.
 * Used by channel-specific code to bypass per-chat serialization when steer
 * mode is active — allowing follow-up messages to run concurrently so the
 * steer check in `get-reply-run.ts` can inject them into the active agent run.
 */

export type ActiveDispatchTracker = {
  mark(key: string): void;
  clear(key: string): void;
  isActive(key: string): boolean;
};

export function createActiveDispatchTracker(): ActiveDispatchTracker {
  const counts = new Map<string, number>();

  return {
    mark: (key: string): void => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    clear: (key: string): void => {
      const count = counts.get(key) ?? 0;
      if (count <= 1) {
        counts.delete(key);
      } else {
        counts.set(key, count - 1);
      }
    },
    isActive: (key: string): boolean => {
      return (counts.get(key) ?? 0) > 0;
    },
  };
}
