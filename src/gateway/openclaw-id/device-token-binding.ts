// Device tokens bound to the authenticated endpoint key (spec section 5 step 6,
// G5). A token issued over the tunnel records the device key W that obtained
// it; presenting it from any other W, or relayed without the W it was issued
// to, is refused and logged as a security event. The bindings are read from the
// local claw record once at Gateway start, whatever the Labs switch says, so a
// restart with the switch off keeps refusing tunnel-issued tokens on ordinary
// ingress. Without saved bindings no owner is published at start and checks pass;
// the service publishes one before its tunnel admits a device, and a relayed
// token cannot be issued while none exists.

import type { StoredClaw } from "./claw-store.js";
import {
  isSameOpenClawIdTunnelPrincipal,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

/** A tunnel-issued device token and the device key it is bound to. */
export type DeviceTokenRef = { deviceId: string; role: string; peerKey: string };

/** The binding owner the OpenClaw ID service publishes while it is on. */
export type DeviceTokenBindingOwner = {
  /** The bound peer key of a device token, if any. Synchronous: served from memory. */
  lookup(deviceId: string, role: string): string | undefined;
  /** Reverse read of the same committed bindings; never accepts browser claims. */
  devicesForPeer(peerKey: string, role: string): readonly string[];
  /** Records that a token was issued to `peerKey` (write-through to the claw record). */
  record(
    deviceId: string,
    role: string,
    peerKey: string,
    operatorPrincipal?: OpenClawIdTunnelPrincipal,
  ): Promise<void>;
  /** Personal inference requires the same original live human listing. */
  isOperatorBindingCurrent(deviceId: string, principal: OpenClawIdTunnelPrincipal): boolean;
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

/** Capture the binding owner's exact reverse cohort for personal HTTP admission. */
export async function prepareOpenClawIdOperatorDeviceBindings(
  principal: OpenClawIdTunnelPrincipal,
) {
  const peerKey = principal.peerKey;
  await loading;
  const current = owner;
  if (!current || current === "unreadable") {
    throw new Error("OpenClaw ID device bindings are unavailable.");
  }
  const deviceIds = [...new Set(current.devicesForPeer(peerKey, "operator"))].toSorted();
  return {
    deviceIds,
    isOperatorBindingCurrent: (deviceId: string) =>
      owner === current && current.isOperatorBindingCurrent(deviceId, principal),
    isCurrent: () => {
      if (owner !== current) {
        return false;
      }
      const live = [...new Set(current.devicesForPeer(peerKey, "operator"))].toSorted();
      return live.length === deviceIds.length && live.every((id, index) => id === deviceIds[index]);
    },
  };
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
 * Binds a relayed operator that was delivered no device token (trusted-proxy auth mode,
 * configured operator roles) to its OpenClaw ID peer, without minting a credential.
 * Any token approval persisted for it then follows the membership lifecycle. Best effort:
 * an unavailable owner or failed write leaves the browser an ordinary device.
 */
export async function recordTokenlessOpenClawIdOperator(
  deviceId: string,
  peerKey: string,
  operatorPrincipal?: OpenClawIdTunnelPrincipal,
): Promise<void> {
  if (!owner || owner === "unreadable") {
    return;
  }
  const current = owner;
  try {
    if (
      current.lookup(deviceId, "operator") !== peerKey ||
      (operatorPrincipal && !current.isOperatorBindingCurrent(deviceId, operatorPrincipal))
    ) {
      await current.record(deviceId, "operator", peerKey, operatorPrincipal);
    }
  } catch {
    // Best effort: a failed claw write leaves this browser removable as a device.
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
  operatorPrincipal?: OpenClawIdTunnelPrincipal;
}): Promise<void> {
  if (!params.peerKey) {
    return;
  }
  // An unbound relayed token would work on ordinary ingress and survive its device's removal.
  if (!owner || owner === "unreadable") {
    throw new Error("OpenClaw ID device-token bindings are unavailable; refusing a relayed token");
  }
  await owner.record(params.deviceId, params.role, params.peerKey, params.operatorPrincipal);
}

/** Binding operations share the claw authority's resident record and serialized commit lane. */
export function createDeviceTokenBindingOperations(authority: {
  current: () => StoredClaw | undefined;
  load: () => Promise<StoredClaw | undefined>;
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  commit: (next: StoredClaw) => Promise<void>;
  currentPeer: (peerKey: string) => OpenClawIdTunnelPrincipal | undefined;
  memberKeys: (state: NonNullable<StoredClaw["authority"]>) => ReadonlySet<string>;
  now: () => number;
}) {
  const { load, serialize, commit, currentPeer, memberKeys, now } = authority;
  return {
    /** The device key a tunnel-issued token belongs to (from memory; load first). */
    tokenBinding(deviceId: string, role: string): string | undefined {
      const record = authority.current();
      return record?.token_bindings?.find(
        (binding) => binding.device_id === deviceId && binding.role === role,
      )?.peer_key;
    },

    /** The original signed-device listing must still own this personal inference. */
    isOperatorBindingCurrent(deviceId: string, principal: OpenClawIdTunnelPrincipal): boolean {
      const record = authority.current();
      if (
        principal.kind === "node" ||
        !isSameOpenClawIdTunnelPrincipal(principal, currentPeer(principal.peerKey))
      ) {
        return false;
      }
      const binding = record?.token_bindings?.find(
        (entry) =>
          entry.device_id === deviceId &&
          entry.role === "operator" &&
          entry.peer_key === principal.peerKey,
      );
      return (
        binding?.operator_principal !== undefined &&
        isSameOpenClawIdTunnelPrincipal(binding.operator_principal, principal)
      );
    },

    /** Records peer restrictions; only verified signed-device admission supplies a personal listing. */
    bindToken(
      deviceId: string,
      role: string,
      peerKey: string,
      operatorPrincipal?: OpenClawIdTunnelPrincipal,
    ): Promise<void> {
      const original = operatorPrincipal ? structuredClone(operatorPrincipal) : undefined;
      return serialize(async () => {
        const current = await load();
        if (!current) {
          return;
        }
        if (
          original &&
          (role !== "operator" ||
            original.kind === "node" ||
            original.peerKey !== peerKey ||
            !isSameOpenClawIdTunnelPrincipal(original, currentPeer(peerKey)))
        ) {
          throw new Error("OpenClaw ID operator binding listing changed before admission.");
        }
        const others = (current.token_bindings ?? []).filter(
          (binding) => binding.device_id !== deviceId || binding.role !== role,
        );
        await commit({
          ...current,
          token_bindings: [
            ...others,
            {
              device_id: deviceId,
              role,
              peer_key: peerKey,
              bound_at: now(),
              ...(original ? { operator_principal: original } : {}),
            },
          ],
        });
      });
    },

    /** The tunnel-issued tokens bound to these device keys (from memory; load first). */
    tokensBoundTo(peerKeys: readonly string[]): DeviceTokenRef[] {
      const record = authority.current();
      return (record?.token_bindings ?? [])
        .filter((binding) => peerKeys.includes(binding.peer_key))
        .map((binding) => ({
          deviceId: binding.device_id,
          role: binding.role,
          peerKey: binding.peer_key,
        }));
    },

    /**
     * Tokens still bound to a device key that is no longer in the membership:
     * removals whose revocation did not finish. The binding keeps refusing them
     * meanwhile.
     */
    async orphanedTokens(): Promise<DeviceTokenRef[]> {
      const current = await load();
      const members = new Set<string>(current?.authority ? memberKeys(current.authority) : []);
      return (current?.token_bindings ?? [])
        .filter((binding) => !members.has(binding.peer_key))
        .map((binding) => ({
          deviceId: binding.device_id,
          role: binding.role,
          peerKey: binding.peer_key,
        }));
    },

    /** Drops the bindings of tokens whose revocation was confirmed. */
    unbindTokens(tokens: readonly DeviceTokenRef[]): Promise<void> {
      return serialize(async () => {
        const current = await load();
        const confirmed = (binding: { device_id: string; role: string; peer_key: string }) =>
          tokens.some(
            (token) =>
              token.deviceId === binding.device_id &&
              token.role === binding.role &&
              token.peerKey === binding.peer_key,
          );
        if (current && (current.token_bindings ?? []).some(confirmed)) {
          await commit({
            ...current,
            token_bindings: (current.token_bindings ?? []).filter((binding) => !confirmed(binding)),
          });
        }
      });
    },

    /** Drops the bindings of removed device keys; returns the (device, role) tokens to revoke. */
    unbindPeers(peerKeys: readonly string[]): Promise<Array<{ deviceId: string; role: string }>> {
      return serialize(async () => {
        const current = await load();
        const removed = (current?.token_bindings ?? []).filter((binding) =>
          peerKeys.includes(binding.peer_key),
        );
        if (current && removed.length > 0) {
          await commit({
            ...current,
            token_bindings: (current.token_bindings ?? []).filter(
              (binding) => !peerKeys.includes(binding.peer_key),
            ),
          });
        }
        return removed.map((binding) => ({ deviceId: binding.device_id, role: binding.role }));
      });
    },
  };
}
