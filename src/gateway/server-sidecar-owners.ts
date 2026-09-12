import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

export type GatewaySidecarStopOwner = ReturnType<typeof createGatewaySidecarStopOwner>;

export function createGatewaySidecarStopOwner() {
  let registered = new Set<GatewayPostReadySidecarHandle>();
  let activeStop: Promise<void> | null = null;
  let failure: Error | undefined;
  let phase: "open" | "closing" | "sealed" = "open";
  const remove = (sidecar: GatewayPostReadySidecarHandle) => {
    registered.delete(sidecar);
  };
  const publish = (...sidecars: GatewayPostReadySidecarHandle[]) => {
    if (phase === "sealed") {
      throw new Error("cannot publish a Gateway sidecar after shutdown sealed its owner");
    }
    for (const sidecar of sidecars) {
      registered.add(sidecar);
    }
    if (phase === "closing") {
      void stop().catch(() => {});
    }
    return () => sidecars.forEach(remove);
  };
  const beginClose = () => {
    if (phase === "open") {
      phase = "closing";
    }
  };
  const stop = () => {
    beginClose();
    if (activeStop) {
      return activeStop;
    }
    // Install single-flight before any stop can synchronously publish another owner.
    const stopping = Promise.resolve().then(async () => {
      const failedSidecars = new Set<GatewayPostReadySidecarHandle>();
      failure = undefined;
      try {
        for (;;) {
          const sidecars = [...registered].filter((sidecar) => !failedSidecars.has(sidecar));
          if (sidecars.length === 0) {
            break;
          }
          sidecars.forEach(remove);
          let pending = sidecars;
          let results: PromiseSettledResult<void>[] = [];
          for (let attempt = 0; attempt < 2; attempt += 1) {
            results = await Promise.allSettled(
              pending.map(async (sidecar) => await sidecar.stop()),
            );
            pending = pending.filter((_sidecar, index) => results[index]?.status === "rejected");
            if (pending.length === 0) {
              break;
            }
          }
          // A late publisher can report a handle already being stopped. Keep its new owners,
          // but remove duplicate ownership of this batch before draining the next batch.
          sidecars.forEach(remove);
          if (pending.length > 0) {
            const rejected = results.find((result) => result.status === "rejected");
            failure ??=
              rejected?.reason instanceof Error
                ? rejected.reason
                : new Error(String(rejected?.reason));
            for (const sidecar of pending) {
              failedSidecars.add(sidecar);
            }
          }
        }
        if (failure) {
          // Preserve ownership after the bounded shutdown retry. A later close can try again.
          registered = new Set([...failedSidecars, ...registered]);
          throw failure;
        }
      } finally {
        activeStop = null;
      }
    });
    activeStop = stopping;
    void stopping.catch(() => {});
    return stopping;
  };

  const sealAndJoin = async () => {
    for (let pending = activeStop; pending; pending = activeStop) {
      try {
        await pending;
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    phase = "sealed";
    // A settled failed stop still owns its handles and original failure until a retry succeeds.
    if (failure || registered.size > 0) {
      throw failure ?? new Error("Gateway sidecar cleanup did not complete");
    }
  };

  return {
    publish,
    remove,
    snapshot: (): readonly GatewayPostReadySidecarHandle[] => [...registered],
    beginClose,
    stop,
    sealAndJoin,
  };
}
