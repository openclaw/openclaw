// Owner-only People projection; no proof keys or service lifecycle state is owned here.
import type {
  IrohEndpointKey,
  MemberRole,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { OpenClawIdAuthority } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";
import { listInviteViews } from "./invites-view.js";
import { listNodeInviteViews } from "./node-invites.js";
import type { createPublicationRetry } from "./publication-retry.js";
import type { PublishOutcome } from "./publisher.js";
import type { OpenClawIdEffects } from "./service.js";

export async function readOwnerLinkStatus(params: {
  enabled: boolean;
  getAuthority: () => Promise<OpenClawIdAuthority>;
  getEffects: () => Promise<OpenClawIdEffects> | undefined;
  lastPublish: PublishOutcome | undefined;
  publicationRetry: Pick<
    ReturnType<typeof createPublicationRetry>,
    "nextRetryAt" | "nextRefreshAt"
  >;
}) {
  const { enabled, getAuthority, getEffects, lastPublish, publicationRetry } = params;
  // Members for the owner's People page: role, the name and email OpenClaw ID
  // reported when they joined by invite (display only), when the owner approved
  // them (seconds), and each device key's live activity read from this Gateway.
  const describeMembers = async (
    members: Record<string, { role: MemberRole; peer_keys: IrohEndpointKey[] }>,
    approvedAt: StoredClaw["member_approved_at"],
  ) => {
    const effects = await getEffects();
    const profiles = await (await getAuthority()).memberProfiles(Object.keys(members));
    const keys = Object.values(members).flatMap((member) => member.peer_keys);
    const activity = effects?.describeActivity?.(keys) ?? {};
    return Object.entries(members).map(([accountId, member]) => {
      const profile = profiles[accountId];
      return {
        accountId,
        role: member.role,
        peerKeys: member.peer_keys,
        email: profile?.email ?? null,
        displayName: profile?.displayName ?? null,
        approvedAt: approvedAt?.[accountId] ?? null,
        devices: member.peer_keys.map((peerKey) => ({
          peerKey,
          ...(activity[peerKey] ?? { connections: 0, lastSeenAt: null, runs: [] }),
        })),
      };
    });
  };

  if (!enabled) {
    return { linked: false as const, publication: undefined };
  }
  const record = await (await getAuthority()).load();
  const state = record?.authority;
  const { describeOwnerDevices } = await import("./owner-devices-view.js");

  return {
    linked: Boolean(state),
    clawId: record?.claw_id,
    hostname: record?.hostname ?? undefined,
    rootPub: state?.anchor.root_pub,
    seq: state?.seq,
    // The machine keys the stored binding names, and how far Discovery has caught up.
    binding: record?.binding
      ? {
          bindingSeq: record.binding.body.binding_seq,
          kSrv: record.binding.body.k_srv,
          kGw: record.binding.body.k_gw,
          publishedBindingSeq: record.discovery.published_binding_seq,
        }
      : undefined,
    ownerDevices: state ? describeOwnerDevices(state, Math.floor(Date.now() / 1000)) : [],
    members: state ? await describeMembers(state.members, record?.member_approved_at) : [],
    invites: listInviteViews(record, Math.floor(Date.now() / 1000)),
    nodes: Object.entries(state?.nodes ?? {}).map(([peerKey, node]) => ({
      peerKey,
      label: node.label,
      description: node.description,
      listedSeq: node.listed_seq,
      addedBy: node.added_by,
      lastSeen: node.last_seen,
      inviteId: node.invite_id,
    })),
    nodeInvites: await listNodeInviteViews(record, Math.floor(Date.now() / 1000)),
    // After a restart, the last publication recorded with the claw stands in.
    publication:
      (lastPublish?.state === "failed"
        ? { ...lastPublish, retryAt: publicationRetry.nextRetryAt() }
        : lastPublish?.state === "published"
          ? { ...lastPublish, refreshAt: publicationRetry.nextRefreshAt() }
          : lastPublish) ??
      (record?.discovery.owner_account_id
        ? {
            state: "published" as const,
            ownerAccountId: record.discovery.owner_account_id,
            snapshotSeq: record.discovery.published_snapshot_seq,
            snapshotIssuedAt: record.discovery.published_snapshot_at ?? 0,
          }
        : undefined),
  };
}
