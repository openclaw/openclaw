import { notifyListeners, registerListener } from "../shared/listeners.js";

type CurrentCaller = () => boolean;

type RevocationState = {
  deviceId: string | undefined;
  role: string | undefined;
  references: number;
  revoked: boolean;
  listeners?: Set<() => void>;
};

type RevocationOwner = {
  closed: boolean;
  devices: Map<string, Set<RevocationState>>;
};

type CapturedRevocation = {
  owner: RevocationOwner;
  state: RevocationState;
  isCurrent: CurrentCaller;
  isSourceCurrent: CurrentCaller;
  isRevocationCurrent: CurrentCaller;
  releaseClientRevocation?: () => void;
};

const owners = new WeakMap<object, RevocationOwner>();
const captures = new WeakMap<() => unknown, CapturedRevocation>();

function getOwner(context: object): RevocationOwner {
  let owner = owners.get(context);
  if (!owner) {
    owner = { closed: false, devices: new Map() };
    owners.set(context, owner);
  }
  return owner;
}

function releaseHold(capture: CapturedRevocation): () => void {
  const { owner, state } = capture;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.references -= 1;
    if (state.references !== 0) {
      return;
    }
    capture.releaseClientRevocation?.();
    capture.releaseClientRevocation = undefined;
    state.listeners?.clear();
    if (!state.deviceId) {
      return;
    }
    const bucket = owner.devices.get(state.deviceId);
    bucket?.delete(state);
    if (bucket?.size === 0) {
      owner.devices.delete(state.deviceId);
    }
  };
}

function revoke(state: RevocationState): void {
  if (state.revoked) {
    return;
  }
  state.revoked = true;
  notifyListeners(state.listeners ?? [], undefined);
}

/** Capture the attested identity before dispatch yields, without retaining credentials or sockets. */
export function captureGatewayDeviceRevocation(
  context: object,
  identity: { deviceId?: string; role?: string },
  hasCurrentClientAuthority: CurrentCaller,
  connectionSignal?: AbortSignal,
  sourceAuthority?: {
    isCurrent: CurrentCaller;
    subscribe: (onRevoked: () => void) => () => void;
  },
): { isCurrent: CurrentCaller; release: () => void } {
  const owner = getOwner(context);
  const state: RevocationState = {
    deviceId: identity.deviceId,
    role: identity.role,
    references: 1,
    revoked: false,
  };
  if (state.deviceId && !owner.closed) {
    let bucket = owner.devices.get(state.deviceId);
    if (!bucket) {
      bucket = new Set();
      owner.devices.set(state.deviceId, bucket);
    }
    bucket.add(state);
  }
  // A live connection remains in the Gateway's ordinary invalidation index.
  // After disconnect, only an owned request or continuation may use this capture.
  const isRevocationCurrent = () =>
    !owner.closed &&
    !state.revoked &&
    (state.references > 0 || connectionSignal?.aborted === false);
  const isCurrent = () => isRevocationCurrent() && hasCurrentClientAuthority();
  // The request callback also fences tentative transport generations. Accepted
  // work follows the subscribed source owner's committed revocations instead.
  const isSourceCurrent = sourceAuthority
    ? () => isRevocationCurrent() && sourceAuthority.isCurrent()
    : isCurrent;
  const capture: CapturedRevocation = {
    owner,
    state,
    isCurrent,
    isSourceCurrent,
    isRevocationCurrent,
  };
  captures.set(isCurrent, capture);
  capture.releaseClientRevocation = sourceAuthority?.subscribe(() => revoke(state));
  return { isCurrent, release: releaseHold(capture) };
}

/** Carry the original capture through a composed commit guard without changing its contract. */
export function bindGatewayDeviceRevocation<T extends () => unknown>(
  guard: T,
  isCurrent: CurrentCaller | undefined,
): T {
  const capture = isCurrent ? captures.get(isCurrent) : undefined;
  if (capture) {
    captures.set(guard, capture);
  }
  return guard;
}

/** Read only owner-held revocation/lifetime facts, without invoking the caller authority callback. */
export function readGatewayDeviceRevocationGuard(
  guard: (() => unknown) | undefined,
): CurrentCaller | undefined {
  return guard ? captures.get(guard)?.isRevocationCurrent : undefined;
}

/** Original committed source authority, excluding tentative transport and later request lifetimes. */
export function readGatewayDeviceSourceAuthority(
  guard: (() => unknown) | undefined,
): CurrentCaller | undefined {
  return guard ? captures.get(guard)?.isSourceCurrent : undefined;
}

/** Notify retained work of access revocation, independently of transport or Gateway shutdown. */
export function onGatewayDeviceSourceRevoked(
  guard: (() => unknown) | undefined,
  onRevoked: () => void,
): (() => void) | undefined {
  const capture = guard ? captures.get(guard) : undefined;
  if (!capture) {
    return undefined;
  }
  const unsubscribe = registerListener((capture.state.listeners ??= new Set()), onRevoked);
  if (capture.state.revoked) {
    onRevoked();
  }
  return unsubscribe;
}

/** Transfer a hold on the original captured state, never recapture a later device/session. */
export function retainGatewayDeviceRevocation(
  guard: (() => unknown) | undefined,
): (() => void) | undefined {
  const capture = guard ? captures.get(guard) : undefined;
  if (!capture) {
    return undefined;
  }
  if (!capture.isCurrent() || capture.state.references === 0) {
    throw new Error("Gateway caller authority is no longer active.");
  }
  capture.state.references += 1;
  return releaseHold(capture);
}

export function invalidateGatewayDeviceRevocation(
  context: object,
  deviceId: string,
  role?: string,
): void {
  for (const state of owners.get(context)?.devices.get(deviceId) ?? []) {
    if (!role || state.role === role) {
      revoke(state);
    }
  }
}

export function closeGatewayDeviceRevocation(context: object): void {
  const owner = getOwner(context);
  owner.closed = true;
  for (const bucket of owner.devices.values()) {
    bucket.clear();
  }
  owner.devices.clear();
}
