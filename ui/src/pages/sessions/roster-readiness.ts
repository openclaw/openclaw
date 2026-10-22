import { createDeferredCore } from "../../../../src/shared/deferred.js";

export function createSessionsRosterReadiness(state: {
  loading: boolean;
  roster: Promise<null> | null;
}) {
  let pending: ReturnType<typeof createDeferredCore<null>> | undefined;
  let settledError: string | null = null;

  function begin() {
    if (pending) {
      return;
    }
    settledError = null;
    pending = createDeferredCore<null>();
    state.roster = pending.promise;
    // The owner can publish before the native error boundary starts observing.
    void state.roster.catch(() => undefined);
  }

  function settle(error: string | null) {
    if (pending) {
      const completion = pending;
      pending = undefined;
      settledError = error;
      if (error) {
        completion.reject(new Error(error));
      } else {
        completion.resolve(null);
      }
    } else if (error !== settledError) {
      settledError = error;
      state.roster = error ? Promise.reject(new Error(error)) : null;
      void state.roster?.catch(() => undefined);
    }
  }

  function dispose() {
    pending?.resolve(null);
    pending = undefined;
  }

  function retire() {
    dispose();
    settledError = null;
    state.roster = null;
  }

  return {
    restart(connected: boolean) {
      retire();
      if (connected) {
        begin();
      }
    },
    update(loading: boolean, error: string | null) {
      state.loading = loading;
      if (loading) {
        begin();
      } else {
        settle(error);
      }
    },
    retire,
    dispose,
  };
}
