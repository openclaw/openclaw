import type { acquireFileLockSync } from "./file-lock-manager.js";

export type GatewayStateProjection = {
  readonly lockPath: string;
  readonly verifiedAt: number | undefined;
  verifyStillHeld(): boolean;
  retain(): GatewayStateProjection;
  release(): void;
};

/** Carry the same physical sidecar through relocation and accepted schema work. */
export function createGatewayStateProjectionResource(
  lock: ReturnType<typeof acquireFileLockSync>,
  invalidateReads: () => void,
): GatewayStateProjection {
  let references = 1;
  let verifiedAt: number | undefined;
  const verify = () => {
    verifiedAt = undefined;
    if (!lock.verifyStillHeld()) {
      return false;
    }
    verifiedAt = performance.now();
    return true;
  };
  const reference = (): GatewayStateProjection => {
    let released = false;
    return {
      lockPath: lock.lockPath,
      get verifiedAt() {
        return released ? undefined : verifiedAt;
      },
      verifyStillHeld: () => !released && verify(),
      retain() {
        if (released || !verify()) {
          throw new Error("Gateway state projection is no longer current");
        }
        references += 1;
        return reference();
      },
      release() {
        invalidateReads();
        if (released) {
          return;
        }
        if (references === 1) {
          lock.release();
        }
        references -= 1;
        released = true;
      },
    };
  };
  return reference();
}
