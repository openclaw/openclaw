import { z } from "zod";
// Gateway identity of an admitted OpenClaw ID tunnel device (OCF-225). The
// tunnel child authenticates the device endpoint key W in the QUIC handshake
// and the private ingress listener attributes the request to it; this module
// maps W onto the Gateway's existing auth vocabulary:
// - an active owner device is the Gateway owner (no role ceiling);
// - a member is a trusted-proxy user, `openclaw-id:<account_id>`, whose
//   operator scopes are capped by a built-in operator role policy for the
//   member's OpenClaw ID role (operator or viewer).
// While OpenClaw ID is off no resolver is published and nothing here runs.
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import {
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SCOPE,
  WRITE_SCOPE,
} from "../operator-scopes.js";

/** OpenClaw ID member roles (the protocol's `MemberRole`). */
type OpenClawIdMemberRole = "operator" | "viewer";

/** Who an admitted tunnel device is, decided by the Gateway's membership authority. */
export type OpenClawIdTunnelPrincipal = (
  | { kind: "owner"; peerKey: string }
  | { kind: "member"; peerKey: string; accountId: string; role: OpenClawIdMemberRole }
) & {
  /** The resident membership owner supplies the original listing, not transport callers. */
  authority?: {
    clawId: string;
    rootPub: string;
    listedSeq: number;
    ownerDevice?: string;
  };
};

const sourceFields = {
  peerKey: z.string().regex(/^iroh:[a-f0-9]{64}$/),
  authority: z.strictObject({
    clawId: z.string().min(1).max(256),
    rootPub: z.string().min(1).max(256),
    listedSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ownerDevice: z.string().min(1).max(256).optional(),
  }),
};

/** Durable sources require the claw/root/listing identity; a bare peer is not recovery evidence. */
export const openClawIdRecoveryPrincipalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner"), ...sourceFields }),
  z.strictObject({
    kind: z.literal("member"),
    ...sourceFields,
    accountId: z.string().min(1).max(256),
    role: z.enum(["operator", "viewer"]),
  }),
]);

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
  return await resolver(peerKey);
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

/**
 * True while the membership authority still admits `principal` as it did at
 * admission: same kind, account and role. A removed device, a role change, or
 * OpenClaw ID turning off (no lookup published) makes it false.
 */
export function isOpenClawIdTunnelPrincipalCurrent(principal: OpenClawIdTunnelPrincipal): boolean {
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
    (principal.kind === "member" &&
      current.accountId === principal.accountId &&
      current.role === principal.role)
  );
}

/**
 * True when two retained principals name the same admitted device listing: the
 * same peer, kind, account and role under the same claw, root and listing.
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
  return (
    left.kind === "owner" ||
    (right.kind === "member" && left.accountId === right.accountId && left.role === right.role)
  );
}

/** The trusted-proxy user of a member; owners act as the Gateway owner and carry none. */
export function openclawIdTunnelUser(principal: OpenClawIdTunnelPrincipal): string | undefined {
  return principal.kind === "member" ? `openclaw-id:${principal.accountId}` : undefined;
}

// Operators chat and use the claw normally; config, admin and pairing stay with owners.
const OPERATOR_POLICY: GatewayOperatorRoleDefinition = Object.freeze({
  sessions: Object.freeze({ others: "write" as const }),
  agents: "*" as const,
  scopes: [READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE, QUESTIONS_SCOPE, TALK_SCOPE],
});

// Viewers read only: no chat.send, no session writes.
const VIEWER_POLICY: GatewayOperatorRoleDefinition = Object.freeze({
  sessions: Object.freeze({ others: "view" as const }),
  agents: "*" as const,
  scopes: [READ_SCOPE],
});

/**
 * The operator role policy that caps a tunnel principal's scopes, or undefined
 * for owner devices, which keep full owner authority.
 */
export function openclawIdTunnelRolePolicy(
  principal: OpenClawIdTunnelPrincipal | undefined,
): GatewayOperatorRoleDefinition | undefined {
  if (principal?.kind !== "member") {
    return undefined;
  }
  return principal.role === "operator" ? OPERATOR_POLICY : VIEWER_POLICY;
}

/** Wait only for local authority hydration; recovery does not count as a tunnel admission. */
export async function prepareOpenClawIdTunnelPrincipal(
  principal: OpenClawIdTunnelPrincipal,
): Promise<void> {
  await prepareLookup?.();
  if (!isOpenClawIdTunnelPrincipalCurrent(principal)) {
    throw new Error("OpenClaw ID membership authority changed");
  }
}
