// Gateway identity of an admitted OpenClaw ID tunnel device (OCF-225): an active
// owner device, or a member with its OpenClaw ID role. The membership authority
// decides it from the device endpoint key W.

/** OpenClaw ID member roles (the protocol's `MemberRole`). */
type OpenClawIdMemberRole = "operator" | "viewer";

/** Who an admitted tunnel device is, decided by the Gateway's membership authority. */
export type OpenClawIdTunnelPrincipal =
  | { kind: "owner"; peerKey: string }
  | { kind: "member"; peerKey: string; accountId: string; role: OpenClawIdMemberRole };
