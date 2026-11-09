import { AsyncLocalStorage } from "node:async_hooks";

type CaptureDeferral = {
  phase: "deferred" | "released" | "closed";
  resume: () => void;
};

const captureDeferral = new AsyncLocalStorage<CaptureDeferral>();

/** Update entry points share one deferral until their owner preserves the original state. */
export async function withDeferredDebugProxyCapture<T>(
  run: (resume: () => void) => Promise<T>,
): Promise<T> {
  const inherited = captureDeferral.getStore();
  if (inherited && inherited.phase !== "released") {
    return await run(inherited.resume);
  }
  const scope: CaptureDeferral = {
    phase: "deferred",
    resume: () => {
      if (scope.phase === "deferred") {
        scope.phase = "released";
      }
    },
  };
  return await captureDeferral.run(scope, async () => {
    try {
      return await run(scope.resume);
    } finally {
      // Failed or passive updates cannot let detached callbacks enable capture later.
      if (scope.phase === "deferred") {
        scope.phase = "closed";
      }
    }
  });
}

export function isDebugProxyCaptureDeferred(): boolean {
  const scope = captureDeferral.getStore();
  return scope !== undefined && scope.phase !== "released";
}
