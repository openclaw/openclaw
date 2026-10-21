import { createDeferredCore } from "../shared/deferred.js";

export function createPlacementTestHold() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    entered,
    release,
    wait: () => {
      entered.resolve();
      return release.promise;
    },
  };
}

export function waitForPlacementBoundary(
  boundary: Promise<unknown>,
  operation: Promise<unknown>,
  message?: string,
) {
  return Promise.race([
    boundary,
    operation.then((result): never => {
      throw message ? new Error(message) : result;
    }),
  ]);
}
