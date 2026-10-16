import type { acquireFileLockSync } from "./file-lock-manager.js";

export type GatewayStateProjection = {
  readonly lockPath: string;
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
  const reference = (): GatewayStateProjection => {
    let released = false;
    return {
      lockPath: lock.lockPath,
      verifyStillHeld: () => !released && lock.verifyStillHeld(),
      retain() {
        if (released || !lock.verifyStillHeld()) {
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
