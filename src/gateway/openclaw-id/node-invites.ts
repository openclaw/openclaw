// Node invitation operations reuse the authority owner's serialized load/commit lane.
import {
  registerNodeInvite,
  submitNodeRedemption,
  nodeVerificationCode,
  PENDING_REDEMPTION_TTL_SECONDS,
  type IrohEndpointKey,
  type NodeDescription,
  type Channel,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityAccepted, AuthorityRefusal } from "./authority-result.js";
import type { StoredClaw } from "./claw-store.js";
import { isPendingExpired } from "./invite-expiry.js";
import { withSweptInvites } from "./invite-sweep.js";

/** Public node invitation fields exposed only to owners; description is self-reported. */
type NodeInviteView = {
  inviteId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  status: "open" | "pending" | "approved" | "denied" | "expired";
  pending:
    | {
        peerKey: IrohEndpointKey;
        requestedAt: number;
        decideBy: number;
        description: NodeDescription;
        verificationCode: string;
      }
    | undefined;
};

/** Owner-only node invitations, without the stored proof key. */
export async function listNodeInviteViews(
  record: StoredClaw | undefined,
  now: number,
): Promise<NodeInviteView[]> {
  const views = await Promise.all(
    Object.entries(record?.authority?.node_invites ?? {}).map(
      async ([inviteId, invite]): Promise<NodeInviteView> => {
        const status = isPendingExpired(invite, now)
          ? "expired"
          : invite.status === "consumed"
            ? (record?.invite_reports?.[inviteId]?.resolution ?? "denied")
            : invite.status === "pending"
              ? "pending"
              : invite.cap.expires_at <= now
                ? "expired"
                : "open";
        const pending = status === "pending" ? invite.pending : null;
        return {
          inviteId,
          label: invite.cap.label,
          createdAt: invite.cap.created_at,
          expiresAt: invite.cap.expires_at,
          status,
          pending: pending
            ? {
                peerKey: pending.peer_key,
                requestedAt: pending.requested_at,
                decideBy: pending.requested_at + PENDING_REDEMPTION_TTL_SECONDS,
                description: pending.description,
                verificationCode: await nodeVerificationCode({
                  claw_id: invite.cap.claw_id,
                  invite_id: inviteId,
                  peer_key: pending.peer_key,
                  description: pending.description,
                }),
              }
            : undefined,
        };
      },
    ),
  );
  return views.toSorted((a, b) => b.createdAt - a.createdAt);
}

export function createNodeInviteOperations(owner: {
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  load: () => Promise<StoredClaw | undefined>;
  commit: (record: StoredClaw) => Promise<void>;
}) {
  const { serialize, load, commit } = owner;
  return {
    /** Registers an owner-signed node invitation directly, never from mailbox mail. */
    registerNodeInvite(
      input: { cap: unknown; proofKey: Uint8Array },
      channel: Channel,
      isCallerOwner?: () => boolean,
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const stored = await load();
        if (!stored?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const now = Math.floor(Date.now() / 1000);
        const { record: current, events } = withSweptInvites(
          { ...stored, authority: stored.authority },
          now,
        );
        const result = await registerNodeInvite(current.authority, input.cap, input.proofKey, {
          channel,
          now,
        });
        // Tunnel HTTP requires both a valid signature and a still-current owner transport.
        if (isCallerOwner && !isCallerOwner()) {
          return {
            ok: false,
            code: "not_owner_device",
            detail: "only owner devices register node invites",
          };
        }
        if (!result.ok) {
          if (current.authority !== stored.authority) {
            await commit(current);
          }
          return { ok: false, code: result.code, detail: result.detail };
        }
        await commit({ ...current, authority: result.state });
        return { ok: true, status: result.status, events: [...events, ...result.events] };
      });
    },

    /** Records a W-signed accountless node request as pending; only owner approval admits it. */
    redeemNode(input: unknown): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const stored = await load();
        if (!stored?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const now = Math.floor(Date.now() / 1000);
        const { record: current, events } = withSweptInvites(
          { ...stored, authority: stored.authority },
          now,
        );
        const result = await submitNodeRedemption(current.authority, input, now);
        if (!result.ok) {
          if (current.authority !== stored.authority) {
            await commit(current);
          }
          return { ok: false, code: result.code, detail: result.detail };
        }
        await commit({ ...current, authority: result.state });
        return { ok: true, status: result.status, events: [...events, ...result.events] };
      });
    },
  };
}
