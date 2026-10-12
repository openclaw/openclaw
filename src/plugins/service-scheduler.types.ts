/** Host-owned timed work, bound to a plugin service or channel account lifetime. */
export type PluginServiceSchedulerV1 = {
  readonly version: 1;
  readonly signal: AbortSignal;
  now: () => number;
  schedule: (
    params: {
      /** Replaces the pending job with this ID within this scope only. */
      id: string;
      /** Repeats after the previous callback settles; missed periods coalesce. */
      everyMs?: number;
      mode?: "replace" | "earliest";
      run: () => void | Promise<unknown>;
    } & ({ atMs: number } | { delayMs: number }),
  ) => {
    /** Cancels future dispatch; already running work remains owned until settlement. */
    cancel: () => void;
    stop: () => Promise<void>;
  };
  /** A shorter lifetime, also retired and joined by this owner. */
  scope: () => PluginServiceSchedulerV1;
  /** Closes admission, aborts the lifetime signal, and cancels future dispatch. */
  beginClose: () => void;
  /** Closes admission and joins running callbacks and child scopes. */
  stop: () => Promise<void>;
};
