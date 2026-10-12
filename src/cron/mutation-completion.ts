import { AsyncLocalStorage } from "node:async_hooks";
import { captureAsyncWorkTracker } from "../shared/async-work-scope.js";

const mutationMethods = new Set([
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.scratch.set",
]);

type MutationState = {
  method: string;
  open: boolean;
  committed: boolean;
  trackAdmission?: ReturnType<typeof captureAsyncWorkTracker>;
};
const currentMutation = new AsyncLocalStorage<MutationState>();

export type CronMutationCompletion = {
  isCommitted: () => boolean;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};

/** One in-process invocation may preserve only the effect its actual mutation owner accepted. */
export function createCronMutationCompletion(method: string): CronMutationCompletion | undefined {
  if (!mutationMethods.has(method)) {
    return undefined;
  }
  const state: MutationState = {
    method,
    open: true,
    committed: false,
    // Gateway dispatch installs its own scope; admission retains the originating tool.
    ...(method === "cron.run" ? { trackAdmission: captureAsyncWorkTracker() } : {}),
  };
  return {
    isCommitted: () => state.committed,
    run: async <T>(run: () => Promise<T>) => {
      if (!state.open) {
        throw new Error("Cron mutation completion has already settled.");
      }
      try {
        return await currentMutation.run(state, run);
      } finally {
        state.open = false;
      }
    },
  };
}

/** Capture resource ownership before acknowledgement, independently of authorization. */
export function captureCronRunAdmissionTracker():
  | ReturnType<typeof captureAsyncWorkTracker>
  | undefined {
  const state = currentMutation.getStore();
  const track = state?.trackAdmission;
  if (!state?.open || state.method !== "cron.run" || !track) {
    return undefined;
  }
  return async (run) => {
    if (!state.open) {
      throw new Error("Cron mutation completion has already settled.");
    }
    return await track(run);
  };
}

/** Capture at the effect owner; a late callback cannot mark a later invocation. */
export function captureCronMutationCommit(method: string): (() => undefined) | undefined {
  const state = currentMutation.getStore();
  if (!state?.open || state.method !== method) {
    return undefined;
  }
  return () => {
    if (state.open) {
      state.committed = true;
    }
    return undefined;
  };
}
