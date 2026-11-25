import type {
  MemberRole,
  NodeDescription,
} from "../../../packages/openclaw-id-protocol/src/statements/types.js";
// Gateway identity of an admitted OpenClaw ID tunnel device (OCF-225). The
// tunnel child authenticates the device endpoint key W in the QUIC handshake
// and the private ingress listener attributes the request to it; this module
// maps W onto the Gateway's existing auth vocabulary:
// - an active owner device is the Gateway owner (no role ceiling);
// - a member is a trusted-proxy user, `openclaw-id:<account_id>`, whose
//   operator scopes resolve through the linked Gateway profile.
// While OpenClaw ID is off no resolver is published and nothing here runs.
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../../infra/restart-recovery-errors.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";

/** Who an admitted tunnel device is, decided by the Gateway's membership authority. */
export type OpenClawIdTunnelPrincipal = (
  | { kind: "owner"; peerKey: string }
  | { kind: "node"; peerKey: string }
  | { kind: "member"; peerKey: string; accountId: string; role: MemberRole }
) & {
  /** The resident membership owner supplies the original listing, not transport callers. */
  authority?: {
    clawId: string;
    rootPub: string;
    listedSeq: number;
    ownerDevice?: string;
  };
};

/** Resolves a tunnel peer key to its principal, or undefined when it is not admitted now. */
export type OpenClawIdTunnelPrincipalResolver = (
  peerKey: string,
) => Promise<OpenClawIdTunnelPrincipal | undefined>;

/** Synchronously resolves a peer key against the membership already loaded. */
export type OpenClawIdTunnelPrincipalLookup = (
  peerKey: string,
) => OpenClawIdTunnelPrincipal | undefined;

let resolver: OpenClawIdTunnelPrincipalResolver | undefined;
let lookup: OpenClawIdTunnelPrincipalLookup | undefined;
let prepareLookup: (() => Promise<void>) | undefined;
let recordActivity: ((peerKey: string) => void) | undefined;
let memberAccountLookup: ((accountId: string) => boolean) | undefined;

/** The same resident membership owner serves socket and offline profile subjects. */
export function setOpenClawIdMemberAccountLookup(
  next: ((accountId: string) => boolean) | undefined,
): void {
  memberAccountLookup = next;
}

/** Stored provider links identify accounts; only current membership makes them members. */
export function isOpenClawIdProfileMember(accountIds: readonly string[] | undefined): boolean {
  return accountIds?.some((accountId) => memberAccountLookup?.(accountId) === true) ?? false;
}
const changes = new Set<() => void>();

/** Notifies retained work after committed membership changes or a service lifecycle change. */
export function notifyOpenClawIdTunnelPrincipalsChanged(): void {
  notifyListeners(changes, undefined);
}

/** Subscribe before preparation yields so a removed source cannot regain a retained lifetime. */
export function onOpenClawIdTunnelPrincipalsChanged(listener: () => void): () => void {
  return registerListener(changes, listener);
}

/** Publishes or clears the resolver (the OpenClaw ID service does this while it is on). */
export function setOpenClawIdTunnelPrincipalResolver(
  next: OpenClawIdTunnelPrincipalResolver | undefined,
): void {
  resolver = next;
}

/** Membership admits the device; the linked profile decides its operator access. */
export function isOpenClawIdTunnelPrincipalAdmitted(
  principal: OpenClawIdTunnelPrincipal | undefined,
): principal is OpenClawIdTunnelPrincipal {
  return principal !== undefined;
}

/**
 * Resolves the principal of a relayed connection. `null` means no resolver is
 * published (OpenClaw ID off); `undefined` means the key is not admitted.
 */
export async function resolveOpenClawIdTunnelPrincipal(
  peerKey: string,
): Promise<OpenClawIdTunnelPrincipal | undefined | null> {
  if (!resolver) {
    return null;
  }
  const principal = await resolver(peerKey);
  return isOpenClawIdTunnelPrincipalAdmitted(principal) ? principal : undefined;
}

/** Publishes or clears the synchronous lookup, alongside the resolver. */
export function setOpenClawIdTunnelPrincipalLookup(
  next: OpenClawIdTunnelPrincipalLookup | undefined,
  prepare?: () => Promise<void>,
): void {
  lookup = next;
  prepareLookup = prepare;
  notifyOpenClawIdTunnelPrincipalsChanged();
}

/** Background delivery reads current membership without recording device activity. */
export async function prepareOpenClawIdTunnelPrincipalLookup(): Promise<OpenClawIdTunnelPrincipalLookup> {
  await prepareLookup?.();
  return (peerKey) => {
    const principal = lookup?.(peerKey);
    return isOpenClawIdTunnelPrincipalAdmitted(principal) ? principal : undefined;
  };
}

/** Null means the membership owner has not published its current facts. */
export function readOpenClawIdTunnelPrincipal(
  peerKey: string,
): OpenClawIdTunnelPrincipal | undefined | null {
  return lookup ? lookup(peerKey) : null;
}

/**
 * True while the membership authority still admits `principal` as it did at
 * admission: same kind and account. A removed device or
 * OpenClaw ID turning off (no lookup published) makes it false.
 */
export function isOpenClawIdTunnelPrincipalCurrent(principal: OpenClawIdTunnelPrincipal): boolean {
  if (!isOpenClawIdTunnelPrincipalAdmitted(principal)) {
    return false;
  }
  const current = lookup?.(principal.peerKey);
  if (!current || current.kind !== principal.kind) {
    return false;
  }
  const original = principal.authority;
  const live = current.authority;
  if (
    original &&
    (!live ||
      live.clawId !== original.clawId ||
      live.rootPub !== original.rootPub ||
      live.listedSeq !== original.listedSeq ||
      live.ownerDevice !== original.ownerDevice)
  ) {
    return false;
  }
  return (
    current.kind === "owner" ||
    current.kind === "node" ||
    (principal.kind === "member" && current.accountId === principal.accountId)
  );
}

/**
 * True when two retained principals name the same admitted device listing: the
 * same peer, kind and account under the same claw, root and listing.
 * Two absent principals match; a device and a non-device requester do not.
 */
export function isSameOpenClawIdTunnelPrincipal(
  left: OpenClawIdTunnelPrincipal | undefined,
  right: OpenClawIdTunnelPrincipal | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const a = left.authority;
  const b = right.authority;
  // A bare peer without its listing is not evidence of the same approval.
  if (!a || !b || left.peerKey !== right.peerKey || left.kind !== right.kind) {
    return false;
  }
  if (
    a.clawId !== b.clawId ||
    a.rootPub !== b.rootPub ||
    a.listedSeq !== b.listedSeq ||
    a.ownerDevice !== b.ownerDevice
  ) {
    return false;
  }
  if (left.kind === "member" && right.kind === "member") {
    return left.accountId === right.accountId;
  }
  // Owners and nodes carry no account or role; the listing above identifies them.
  return true;
}

/** The trusted-proxy user of a member; owners act as the Gateway owner and carry none. */
export function openclawIdTunnelUser(principal: OpenClawIdTunnelPrincipal): string | undefined {
  return principal.kind === "member" ? `openclaw-id:${principal.accountId}` : undefined;
}

/** Owner devices bypass profile roles; nodes never receive operator scopes. */
export function openclawIdTunnelRolePolicy(
  principal: OpenClawIdTunnelPrincipal | undefined,
): GatewayOperatorRoleDefinition | undefined {
  return principal?.kind === "node"
    ? { scopes: [], agents: [], sessions: { others: "none" } }
    : undefined;
}

/**
 * The named-role policy of a captured operator subject. Members follow their profile.
 * An owner device is the Gateway owner, so no named role applies,
 * even when it is attributed to the personal profile its account is linked to (OCF-510): the
 * profile decides who it is, its certificate what it may do. Others follow their profile's role.
 */
export function openclawIdSubjectRolePolicy(
  principal: OpenClawIdTunnelPrincipal | undefined,
  resolveProfileRole: () => GatewayOperatorRoleDefinition | undefined,
): GatewayOperatorRoleDefinition | undefined {
  if (principal?.kind === "owner") {
    return undefined;
  }
  return (
    openclawIdTunnelRolePolicy(principal) ??
    resolveProfileRole() ??
    (principal?.kind === "member"
      ? { scopes: [], agents: [], sessions: { others: "none" } }
      : undefined)
  );
}

/**
 * The OpenClaw ID owner principal of a real tunnel socket, while its owner authority is current.
 * Synthetic and host-bound ingress clients never qualify: they carry no certificate of their own.
 */
export function currentOwnerDevicePrincipal(
  client:
    | {
        connId?: string;
        internal?: {
          openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
          syntheticClient?: boolean;
          remoteIngressPrincipal?: unknown;
        };
      }
    | null
    | undefined,
): OpenClawIdTunnelPrincipal | undefined {
  const principal = client?.internal?.openclawIdPrincipal;
  return principal?.kind === "owner" &&
    client?.connId &&
    !client.internal?.syntheticClient &&
    !client.internal?.remoteIngressPrincipal &&
    isOpenClawIdTunnelPrincipalCurrent(principal)
    ? principal
    : undefined;
}

export class OpenClawIdPrincipalChangedError extends GatewayOperatorRecoveryAuthorizationError {
  constructor() {
    super("OpenClaw ID membership changed. Reconnect before starting a request.");
  }
}

/** Wait only for local authority hydration; recovery does not count as a tunnel admission. */
export async function prepareOpenClawIdTunnelPrincipal(
  principal: OpenClawIdTunnelPrincipal,
): Promise<void> {
  await prepareLookup?.();
  if (!isOpenClawIdTunnelPrincipalCurrent(principal)) {
    throw new OpenClawIdPrincipalChangedError();
  }
}

/** Records authenticated tunnel traffic; bare caller-supplied keys cannot refresh admission. */
export function recordOpenClawIdTunnelActivity(principal: OpenClawIdTunnelPrincipal): void {
  if (isOpenClawIdTunnelPrincipalCurrent(principal)) {
    recordActivity?.(principal.peerKey);
  }
}

/** The service owns activity persistence alongside its resolver lifetime. */
export function setOpenClawIdTunnelActivityRecorder(next: typeof recordActivity): void {
  recordActivity = next;
}

let nodeDescription: ((peerKey: string) => NodeDescription | undefined) | undefined;

/** The resident membership owner supplies the signed surface, never connect metadata. */
export function setOpenClawIdNodeDescriptionLookup(next: typeof nodeDescription): void {
  nodeDescription = next;
}

export function openClawIdNodeDescription(peerKey: string): NodeDescription | undefined {
  return nodeDescription?.(peerKey);
}
