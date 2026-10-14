import { createDeferredCore } from "../../shared/deferred.js";

export function createServiceChildCleanup() {
  const completion = createDeferredCore();
  let authorityClose: Promise<PromiseSettledResult<void>> | undefined;
  const promise = (async () => {
    const [outcome] = await Promise.allSettled([completion.promise]);
    const closed = await authorityClose;
    const failure = closed?.status === "rejected" ? closed : outcome;
    if (failure.status === "rejected") {
      throw failure.reason;
    }
  })();
  const outcome = Promise.allSettled([promise]);

  return {
    completion,
    promise,
    outcome,
    bindAuthorityClose:
      (close: () => Promise<void>, onFailure: (reason: unknown) => void) => () => {
        authorityClose = Promise.allSettled([close()]).then(([result]) => {
          if (result.status === "rejected") {
            onFailure(result.reason);
          }
          return result;
        });
      },
  };
}
