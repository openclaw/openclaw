import type { GatewayStartupOperation } from "../../gateway/server-public.js";
import { SqliteIntegrityWorkerInterruptedError } from "../../infra/sqlite-integrity-worker-error.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";

export function createGatewayStartupOperations(): {
  run: GatewayStartupOperation;
  close(): void;
  cancelledWith(error: unknown): boolean;
  failedWith(error: unknown): boolean;
  stopCompletion?: Promise<void>;
  drain(): Promise<void>;
} {
  const scope = new AsyncWorkScope();
  let failure: { error: unknown } | undefined;
  // A process-group stop can kill a child before its separate admission owner is cancelled.
  const cancelledWith = (error: unknown) =>
    scope.signal.aborted &&
    (error === scope.signal.reason ||
      (error instanceof SqliteIntegrityWorkerInterruptedError &&
        (error.signal === "SIGTERM" || error.signal === "SIGINT")));
  const run: GatewayStartupOperation = async (operation) => {
    if (scope.isClosing) {
      throw scope.signal.reason;
    }
    return await scope.track(async () => {
      try {
        return await operation(scope.signal);
      } catch (error) {
        if (!cancelledWith(error)) {
          failure ??= { error };
        }
        throw error;
      }
    });
  };
  return {
    run,
    close: () => scope.beginClose(),
    cancelledWith,
    failedWith: (error: unknown) => failure !== undefined && failure.error === error,
    async drain() {
      await scope.drain();
      // AsyncWorkScope joins descendants with allSettled; failed cleanup must
      // still make the accepted stop fail rather than certify a clean exit.
      if (failure) {
        throw failure.error;
      }
    },
  };
}
