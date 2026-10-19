import { vi } from "vitest";
import * as tmpDir from "../../infra/tmp-openclaw-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateContext from "../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";

const captureStateContext = stateContext.captureOpenClawStateWorkerContext;

export function useSkillUploadStoreLocation(databasePath: string, tempRootDir: string): void {
  vi.spyOn(stateContext, "captureOpenClawStateWorkerContext").mockImplementation((options) =>
    captureStateContext(options ?? { path: databasePath }),
  );
  vi.spyOn(tmpDir, "resolvePreferredOpenClawTmpDir").mockReturnValue(tempRootDir);
}

/** Observe real worker settlement without making the interval callback an awaitable API. */
export function observeSkillUploadRenewal(): Promise<void> {
  const settled = createDeferredCore();
  const runOperation = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(runOperation, {
      apply(target, receiver, [context, operation, options]: Parameters<typeof runOperation>) {
        return Reflect.apply(target, receiver, [
          context,
          (scope: Parameters<typeof operation>[0]) =>
            operation({
              execute: new Proxy(scope.execute, {
                async apply(execute, executeReceiver, args: Parameters<typeof scope.execute>) {
                  try {
                    return await Reflect.apply(execute, executeReceiver, args);
                  } finally {
                    if (args[0].type === "skillUploads.renew") {
                      settled.resolve();
                    }
                  }
                },
              }),
            }),
          options,
        ]);
      },
    }),
  );
  return settled.promise;
}
