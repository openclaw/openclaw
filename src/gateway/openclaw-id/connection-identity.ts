// Connection identity and current-owner disclosure checks consume the claw authority.
// Display claims never authorize access and are bound to the registered owner subject.
import type {
  Channel,
  IrohEndpointKey,
  MemberRole,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { OpenClawIdAuthority } from "./authority.js";

/** Who a connection is, as `openclawId.status` reports it to that connection. */
export type OpenClawIdConnectionIdentity =
  | { kind: "local"; accountEmail: string | null; accountName: string | null }
  | { kind: "none" }
  | {
      kind: "owner";
      deviceLabel: string | null;
      ownerAccountId: string | null;
      accountEmail: string | null;
      accountName: string | null;
    }
  | {
      kind: "member";
      role: MemberRole;
      accountId: string;
      email: string | null;
      displayName: string | null;
      invitedBy: { name: string | null; email: string | null } | null;
    };

/** Builds the status projection and live owner checks over the service's authority. */
export function createOpenClawIdConnectionAccess(params: {
  enabled: () => boolean;
  getAuthority: () => Promise<OpenClawIdAuthority>;
}) {
  // Prepare asynchronous hashing, but recheck live membership/config at the actual send.
  const prepareOwnerClientCheck = async (
    channel: Exclude<Channel, "mailbox"> | undefined,
    peerKey: string | undefined,
  ): Promise<() => boolean> => {
    if (!params.enabled()) {
      return () => false;
    }
    const check =
      channel === "local_operator"
        ? () => true
        : channel === "tunnel" && peerKey
          ? await (await params.getAuthority()).prepareOwnerPeerCheck(peerKey)
          : () => false;
    return () => params.enabled() && check();
  };

  return {
    /** Prepares a synchronous current-owner guard for event publication. */
    prepareOwnerClientCheck,
    /** Counts active owner certificates; callers must authorize the owner before disclosing. */
    async ownerDeviceCount(): Promise<number> {
      const owner = await params.getAuthority();
      const { isOwnerDeviceActive } =
        await import("../../../packages/openclaw-id-protocol/src/index.js");
      const state = owner.current()?.authority;
      return state
        ? Object.values(state.owner_devices).filter((device) =>
            isOwnerDeviceActive(device, Math.floor(Date.now() / 1000)),
          ).length
        : 0;
    },
    /**
     * Whether a Gateway client may read and manage people: the direct-loopback
     * operator (who already holds the Gateway token and runs the root ceremonies),
     * or a tunnel client whose authenticated device key belongs to an owner device
     * that is active right now (listed, current epoch, unexpired). Members and
     * every other client are refused; a scope alone is never enough.
     */
    async isOwnerClient(
      channel: Exclude<Channel, "mailbox"> | undefined,
      peerKey: string | undefined,
    ): Promise<boolean> {
      return (await prepareOwnerClientCheck(channel, peerKey))();
    },

    /**
     * Who this connection is, for the account menu: the direct-loopback operator,
     * or over the tunnel the owner device (its label and the claw's OpenClaw ID
     * owner account) or the member (their own account, role and the name and email
     * reported when they joined), plus inviter display details. No member roster.
     */
    async connectionIdentity(
      channel: "local_operator" | "tunnel" | undefined,
      peerKey: string | undefined,
    ): Promise<OpenClawIdConnectionIdentity> {
      if (!params.enabled()) {
        return channel === "local_operator"
          ? { kind: "local", accountEmail: null, accountName: null }
          : { kind: "none" };
      }
      const store = await params.getAuthority();
      const peer = channel === "tunnel" && peerKey ? await store.resolvePeer(peerKey) : undefined;
      const record = store.current();
      // Display claims belong to the linked account, not an unrelated local sign-in.
      const profile =
        record?.owner_profile?.sub === record?.discovery.owner_account_id ||
        (channel === "local_operator" && !record?.discovery.owner_account_id)
          ? record?.owner_profile
          : undefined;
      const account = { accountEmail: profile?.email ?? null, accountName: profile?.name ?? null };
      if (channel === "local_operator") {
        return { kind: "local", ...account };
      }
      if (peer?.kind === "owner") {
        const device = Object.values(record?.authority?.owner_devices ?? {}).find((entry) =>
          // SAFETY: peerKey is compared by string equality only; a malformed key matches no certificate.
          entry.cert.body.peer_keys.includes(peerKey as IrohEndpointKey),
        );
        return {
          kind: "owner",
          deviceLabel: device?.cert.body.label ?? null,
          ownerAccountId: record?.discovery.owner_account_id ?? null,
          ...account,
        };
      }
      if (peer?.kind === "member") {
        const member = (await store.memberProfiles([peer.accountId]))[peer.accountId];
        const current = peerKey ? await store.resolvePeer(peerKey) : undefined;
        if (
          !params.enabled() ||
          current?.kind !== "member" ||
          current.accountId !== peer.accountId ||
          current.role !== peer.role
        ) {
          return { kind: "none" };
        }
        return {
          kind: "member",
          role: peer.role,
          accountId: peer.accountId,
          email: member?.email ?? null,
          displayName: member?.displayName ?? null,
          invitedBy:
            profile && (profile.name || profile.email)
              ? { name: profile.name ?? null, email: profile.email ?? null }
              : null,
        };
      }
      return { kind: "none" };
    },
  };
}
