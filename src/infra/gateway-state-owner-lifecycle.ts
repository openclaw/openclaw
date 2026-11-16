import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { LockPayload } from "./gateway-lock-payload.js";
import type { StateOwnerDirectoryIdentity } from "./gateway-state-owner-directory.js";
import type { startGatewayStateOwnerHeartbeat } from "./gateway-state-owner-heartbeat.js";

export type GatewayStateProjection = {
  readonly lockPath: string;
  verifyStillHeld(): boolean;
  retain(): GatewayStateProjection;
  release(): void;
};

export type StateOwnerFile = Pick<
  GatewayStateProjection,
  "lockPath" | "verifyStillHeld" | "release"
>;

/** Carry the same physical sidecar through relocation and accepted schema work. */
export function createGatewayStateProjection(lock: StateOwnerFile): GatewayStateProjection {
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
        readOwnerPaths.clear();
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

export type ProcessOwner = {
  key: string;
  path: string;
  kind: "process" | "schema";
  payload: LockPayload;
  projectionPath?: string;
  getProjection?: () => GatewayStateProjection | undefined;
  locks: Set<StateOwnerFile>;
  heartbeat?: ReturnType<typeof startGatewayStateOwnerHeartbeat>;
  lost: AbortController;
  projectionDirectories: StateOwnerDirectoryIdentity[];
  // Retained leases keep custody after this stops new admission.
  accepting: boolean;
  /** Runs once physical custody ends, after the last retained lease. */
  onReleased?: () => void;
};

export function hasPhysicalOwnership(owner: ProcessOwner): boolean {
  try {
    return verifyOwnerLock(owner, owner.locks.values().next().value);
  } catch (error) {
    // Observers report their own unavailable-read contract; lease assertions keep the loss cause.
    if (owner.lost.signal.aborted) {
      return false;
    }
    throw error;
  }
}

export function verifyOwnerLock(owner: ProcessOwner, lock: StateOwnerFile | undefined): boolean {
  owner.lost.signal.throwIfAborted();
  owner.heartbeat?.inspect();
  if (!lock) {
    return false;
  }
  const projection = owner.getProjection?.();
  if (projection && owner.heartbeat && !owner.heartbeat.paths.has(projection.lockPath)) {
    owner.heartbeat.register(projection);
  }
  // Live process custody cannot be reclaimed by a peer. Its worker observes physical loss;
  // supported release and retirement revoke the local owner immediately.
  const role = owner.payload.role ?? "gateway";
  if (
    owner.kind === "process" &&
    owner.accepting &&
    (role === "gateway" || role === "agent-embedded") &&
    owner.heartbeat
  ) {
    owner.heartbeat.assertActive();
    return true;
  }
  if (!lock.verifyStillHeld()) {
    loseOwner(
      owner,
      new Error(`${lock.lockPath}: no longer current; lock removed/replaced; restart the Gateway.`),
    );
    return false;
  }
  return true;
}

const log = createSubsystemLogger("gateway/state");

export function loseOwner(owner: ProcessOwner, error: Error) {
  if (owner.lost.signal.aborted) {
    return;
  }
  owner.accepting = false;
  readOwnerPaths.clear();
  void owner.heartbeat?.stop();
  log.error(error.message);
  owner.lost.abort(error);
}

export function observeOwnerLoss(owner: ProcessOwner, error: Error, lockPath?: string) {
  const held = [...owner.locks, owner.getProjection?.()];
  if (!lockPath || held.some((lock) => lock?.lockPath === lockPath)) {
    loseOwner(owner, error);
  }
}

export const readOwnerPaths = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayStateReadOwnerPaths"),
  () => new Map<string, ProcessOwner>(),
);

export const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayStateOwners"),
  () => new Map<string, ProcessOwner>(),
);
