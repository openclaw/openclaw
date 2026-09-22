import { vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import type { SkillUploadStore } from "./upload-store.js";
import "./upload-store.js";

type SkillUploadStoreTestApi = {
  createSkillUploadStore(options?: {
    env?: NodeJS.ProcessEnv;
    installLeaseHeartbeatMs?: number;
    installLeaseMs?: number;
    path?: string;
    tempRootDir?: string;
    ttlMs?: number;
  }): SkillUploadStore;
};

function getTestApi(): SkillUploadStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.skillUploadStoreTestApi")
  ] as SkillUploadStoreTestApi;
}

export function createSkillUploadStore(
  options?: Parameters<SkillUploadStoreTestApi["createSkillUploadStore"]>[0],
): SkillUploadStore {
  return getTestApi().createSkillUploadStore(options);
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
