import { AsyncLocalStorage } from "node:async_hooks";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import type { CronStoreTransactionHooks } from "./store/transaction-hooks.types.js";

const mutationMethods = new Set([
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.scratch.set",
]);

type MutationState = { method: string; open: boolean; committed: boolean };
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
  const state: MutationState = { method, open: true, committed: false };
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

/** Record the SQL commit before fallible coordinator cleanup, preserving existing hooks. */
export function withCronMutationCommitHook(
  method: string,
  hooks?: CronStoreTransactionHooks,
): CronStoreTransactionHooks | undefined {
  const committed = captureCronMutationCommit(method);
  if (!committed) {
    return hooks;
  }
  return {
    ...hooks,
    afterWrite: (db) => {
      deferSqlitePostCommitPublication(db, committed);
      return hooks?.afterWrite?.(db);
    },
  };
}
