// Device tokens bound to the authenticated endpoint key (spec section 5 step 6,
// G5). A token issued over the tunnel records the device key W that obtained
// it; presenting it from any other W, or relayed without the W it was issued
// to, is refused and logged as a security event. The bindings are read from the
// local claw record once at Gateway start, whatever the Labs switch says, so a
// restart with the switch off keeps refusing tunnel-issued tokens on ordinary
// ingress. Without saved bindings no owner is published at start and checks pass;
// the service publishes one before its tunnel admits a device, and a relayed
// token cannot be issued while none exists.

/** One recorded binding: the token of (device, role) belongs to `peerKey`. */
export type DeviceTokenBinding = {
  device_id: string;
  role: string;
  peer_key: string;
  bound_at: number;
};

/** The binding owner the OpenClaw ID service publishes while it is on. */
export type DeviceTokenBindingOwner = {
  /** The bound peer key of a device token, if any. Synchronous: served from memory. */
  lookup(deviceId: string, role: string): string | undefined;
  /** Records that a token was issued to `peerKey` (write-through to the claw record). */
  record(deviceId: string, role: string, peerKey: string): Promise<void>;
  /** Drops the bindings of a deleted device's tokens, so a reused identity starts unbound. */
  forget(tokens: ReadonlyArray<{ deviceId: string; role: string; peerKey: string }>): Promise<void>;
  /** Reports a refused token for the security log. */
  reportMismatch(event: {
    deviceId: string;
    role: string;
    boundTo: string | undefined;
    presentedFrom: string | undefined;
  }): void;
};

/** Why a device token was refused on this connection. */
type DeviceTokenPeerRefusal = "device-token-peer-mismatch" | "device-token-bindings-unreadable";

// "unreadable": the saved bindings could not be read, so no device token can be
// told apart from a tunnel-issued one and every device token is refused.
let owner: DeviceTokenBindingOwner | "unreadable" | undefined;
let loading: Promise<void> = Promise.resolve();

/** The authenticated device key of a relayed connection, from its ingress attribution. */
export function openclawIdPeerKeyOf(attribution: {
  kind: string;
  peerKey?: string;
}): string | undefined {
  return attribution.kind === "openclaw-id-tunnel" ? attribution.peerKey : undefined;
}

/** Publishes or clears the binding owner (the OpenClaw ID service does this). */
export function setDeviceTokenBindingOwner(
  next: DeviceTokenBindingOwner | "unreadable" | undefined,
): void {
  owner = next;
}

/** Holds every device-token check until the Gateway-start binding read settles. */
export function setDeviceTokenBindingsLoading(next: Promise<void>): void {
  loading = next;
}

/**
 * Decides whether a verified device token may be used on this connection.
 * `peerKey` is the relayed connection's authenticated W, or undefined for any
 * other ingress. Tokens issued over the tunnel are usable only from their W;
 * relayed connections may use only tokens bound to their own W.
 */
export async function checkDeviceTokenPeer(params: {
  deviceId: string;
  role: string;
  peerKey: string | undefined;
}): Promise<{ ok: true } | { ok: false; reason: DeviceTokenPeerRefusal }> {
  await loading;
  if (!owner) {
    return { ok: true };
  }
  if (owner === "unreadable") {
    return { ok: false, reason: "device-token-bindings-unreadable" };
  }
  let boundTo: string | undefined;
  try {
    boundTo = owner.lookup(params.deviceId, params.role);
  } catch {
    // An uncertain claw commit cannot distinguish unbound tokens from newly bound ones.
    return { ok: false, reason: "device-token-bindings-unreadable" };
  }
  if (boundTo === undefined && params.peerKey === undefined) {
    return { ok: true };
  }
  if (boundTo !== undefined && boundTo === params.peerKey) {
    return { ok: true };
  }
  owner.reportMismatch({
    deviceId: params.deviceId,
    role: params.role,
    boundTo,
    presentedFrom: params.peerKey,
  });
  return { ok: false, reason: "device-token-peer-mismatch" };
}

/**
 * Whether this device's operator token was issued over the tunnel. Such a browser is
 * managed by OpenClaw ID membership (the Access page), not as a device. Unknown or
 * unreadable bindings answer false, keeping ordinary device management.
 */
export function hasOpenClawIdOperatorBinding(deviceId: string): boolean {
  if (!owner || owner === "unreadable") {
    return false;
  }
  try {
    return owner.lookup(deviceId, "operator") !== undefined;
  } catch {
    return false;
  }
}

/**
 * Marks a relayed operator that received no device token (trusted-proxy auth mode,
 * configured operator roles) as an OpenClaw ID browser, without minting a credential.
 * The binding guards no token here, so an unavailable owner only skips the marker.
 */
export async function recordTokenlessOpenClawIdOperator(
  deviceId: string,
  peerKey: string,
): Promise<void> {
  if (!owner || owner === "unreadable") {
    return;
  }
  try {
    if (owner.lookup(deviceId, "operator") !== peerKey) {
      await owner.record(deviceId, "operator", peerKey);
    }
  } catch {
    // Marker only: a failed claw write leaves this browser removable as a device.
  }
}

/** Forgets the bindings of a deleted pairing. Best effort: the pairing is already gone. */
export async function forgetDeviceTokenBindings(
  deviceId: string,
  roles: readonly string[],
): Promise<void> {
  if (!owner || owner === "unreadable") {
    return;
  }
  const current = owner;
  const tokens = roles.flatMap((role) => {
    const peerKey = current.lookup(deviceId, role);
    return peerKey ? [{ deviceId, role, peerKey }] : [];
  });
  if (tokens.length > 0) {
    await current.forget(tokens);
  }
}

/** Records the binding of a token just issued to a relayed connection; no binding, no token. */
export async function recordDeviceTokenPeer(params: {
  deviceId: string;
  role: string;
  peerKey: string | undefined;
}): Promise<void> {
  if (!params.peerKey) {
    return;
  }
  // An unbound relayed token would work on ordinary ingress and survive its device's removal.
  if (!owner || owner === "unreadable") {
    throw new Error("OpenClaw ID device-token bindings are unavailable; refusing a relayed token");
  }
  await owner.record(params.deviceId, params.role, params.peerKey);
}
