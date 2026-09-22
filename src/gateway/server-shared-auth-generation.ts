// Gateway shared-auth generation enforcement.
// Disconnects clients when config writes invalidate shared credentials.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import {
  invalidateGatewayPolicyClient,
  type GatewayPolicyClient,
} from "./server/ws-policy-close.js";

/** Gateway client subset relevant to shared auth generation enforcement. */
export type SharedGatewayAuthClient = GatewayPolicyClient & {
  usesSharedGatewayAuth?: boolean;
  sharedGatewaySessionGeneration?: string;
};

/** Mutable shared auth generation state. */
export type SharedGatewaySessionGenerationState = {
  current: string | undefined;
  required: string | undefined | null;
};

export type SharedGatewaySessionGenerationOwnership = {
  generation: string | undefined;
  previousGeneration: string | undefined;
  revision: number;
};

const stateRevisions = new WeakMap<SharedGatewaySessionGenerationState, number>();
type SharedAuthInvalidation =
  | { kind: "generation"; generation: string | undefined }
  | { kind: "all" };
const invalidationListeners = new WeakMap<
  SharedGatewaySessionGenerationState,
  Set<(event: SharedAuthInvalidation) => void>
>();

const generationReaderStates = resolveGlobalSingleton(
  Symbol.for("openclaw.sharedGatewaySessionGenerationReaders"),
  () => new WeakMap<() => string | undefined, SharedGatewaySessionGenerationState>(),
);

/** Retain the actual generation owner for request admission across an awaited write. */
export function createRequiredSharedGatewaySessionGenerationReader(
  state: SharedGatewaySessionGenerationState,
): () => string | undefined {
  const read = () => getRequiredSharedGatewaySessionGeneration(state);
  generationReaderStates.set(read, state);
  return read;
}

/** Only readers created by this owner provide transaction-safe generation facts. */
export function getSharedGatewaySessionGenerationReaderState(
  read: (() => string | undefined) | undefined,
): SharedGatewaySessionGenerationState | undefined {
  return read ? generationReaderStates.get(read) : undefined;
}

/** Follow this Gateway's committed authentication policy after its client leaves the socket set. */
export function onSharedGatewayAuthInvalidated(
  read: (() => string | undefined) | undefined,
  generation: string | undefined,
  listener: () => void,
): (() => void) | undefined {
  const state = getSharedGatewaySessionGenerationReaderState(read);
  if (!state) {
    return undefined;
  }
  let listeners = invalidationListeners.get(state);
  if (!listeners) {
    listeners = new Set();
    invalidationListeners.set(state, listeners);
  }
  const unsubscribe = registerListener(listeners, (event) => {
    if (event.kind === "all" || event.generation !== generation) {
      listener();
    }
  });
  return () => {
    unsubscribe();
    if (listeners.size === 0 && invalidationListeners.get(state) === listeners) {
      invalidationListeners.delete(state);
    }
  };
}

function publishSharedAuthInvalidation(
  state: SharedGatewaySessionGenerationState | undefined,
  event: SharedAuthInvalidation,
): void {
  if (state) {
    notifyListeners(invalidationListeners.get(state) ?? [], event);
  }
}

function advanceStateRevision(state: SharedGatewaySessionGenerationState): number {
  const revision = (stateRevisions.get(state) ?? 0) + 1;
  stateRevisions.set(state, revision);
  return revision;
}

/** Capture current generation-state ownership without mutating it. */
export function captureSharedGatewaySessionGenerationOwnership(
  state: SharedGatewaySessionGenerationState,
): SharedGatewaySessionGenerationOwnership {
  return {
    generation: state.current,
    previousGeneration: state.current,
    revision: stateRevisions.get(state) ?? 0,
  };
}

/** Disconnect stale shared-auth clients; null revokes every generation. */
export function disconnectStaleSharedGatewayAuthClients(params: {
  clients: Iterable<SharedGatewayAuthClient>;
  expectedGeneration: string | undefined | null;
  state?: SharedGatewaySessionGenerationState;
  revokeSource?: boolean;
}): void {
  for (const gatewayClient of params.clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    if (gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration) {
      continue;
    }
    invalidateGatewayPolicyClient(gatewayClient, {
      reason: "gateway-auth-changed",
      code: 4001,
      message: "gateway auth changed",
      revokeSource: params.revokeSource,
    });
  }
  if (params.revokeSource !== false) {
    publishSharedAuthInvalidation(
      params.state,
      params.expectedGeneration === null
        ? { kind: "all" }
        : { kind: "generation", generation: params.expectedGeneration },
    );
  }
}

/** Resolve the generation clients must use, treating null as "current is required". */
export function getRequiredSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
): string | undefined {
  return state.required === null ? state.current : state.required;
}

/** Claim current only while no later generation-state writer has run. */
export function claimSharedGatewaySessionGenerationIfOwned(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  generation: string | undefined,
): SharedGatewaySessionGenerationOwnership | null {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return null;
  }
  const previousGeneration = state.current;
  state.current = generation;
  return { generation, previousGeneration, revision: advanceStateRevision(state) };
}

/** Check whether a transaction still owns all generation-state mutations. */
export function isSharedGatewaySessionGenerationOwnershipCurrent(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
): boolean {
  return (stateRevisions.get(state) ?? 0) === ownership.revision;
}

/** Replace both generation fields as one ownership-changing mutation. */
function replaceSharedGatewaySessionGenerationState(
  state: SharedGatewaySessionGenerationState,
  next: Pick<SharedGatewaySessionGenerationState, "current" | "required">,
): void {
  state.current = next.current;
  state.required = next.required;
  advanceStateRevision(state);
}

/** Replace both fields only while the caller still owns generation state. */
export function replaceOwnedSharedGatewaySessionGenerationState(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  next: Pick<SharedGatewaySessionGenerationState, "current" | "required">,
): boolean {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return false;
  }
  replaceSharedGatewaySessionGenerationState(state, next);
  return true;
}

/** Restore current only while preserving the required marker owned by the transaction. */
export function restoreOwnedCurrentSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  current: string | undefined,
): boolean {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return false;
  }
  state.current = current;
  advanceStateRevision(state);
  return true;
}

/** Update required only while no later generation-state writer has run. */
export function setRequiredSharedGatewaySessionGenerationIfOwned(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
  required: string | undefined | null,
): SharedGatewaySessionGenerationOwnership | null {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return null;
  }
  state.required = required;
  advanceStateRevision(state);
  return captureSharedGatewaySessionGenerationOwnership(state);
}

/** Finalize only while no later generation-state writer has replaced this owner. */
export function finalizeOwnedSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  ownership: SharedGatewaySessionGenerationOwnership,
): boolean {
  if (!isSharedGatewaySessionGenerationOwnershipCurrent(state, ownership)) {
    return false;
  }
  state.current = ownership.generation;
  if (
    state.required === ownership.generation ||
    (state.required !== null && ownership.previousGeneration !== ownership.generation)
  ) {
    state.required = null;
  }
  advanceStateRevision(state);
  publishSharedAuthInvalidation(state, {
    kind: "generation",
    generation: getRequiredSharedGatewaySessionGeneration(state),
  });
  return true;
}

/** Enforce shared auth generation behavior after a config write. */
export function enforceSharedGatewaySessionGenerationForConfigWrite(params: {
  state: SharedGatewaySessionGenerationState;
  nextConfig: OpenClawConfig;
  resolveRuntimeSnapshotGeneration: () => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
}): void {
  const reloadMode = resolveGatewayReloadSettings(params.nextConfig).mode;
  const nextSharedGatewaySessionGeneration = params.resolveRuntimeSnapshotGeneration();
  replaceSharedGatewaySessionGenerationState(params.state, {
    current: nextSharedGatewaySessionGeneration,
    required: reloadMode === "off" ? nextSharedGatewaySessionGeneration : null,
  });
  disconnectStaleSharedGatewayAuthClients({
    state: params.state,
    clients: params.clients,
    expectedGeneration: nextSharedGatewaySessionGeneration,
  });
}
