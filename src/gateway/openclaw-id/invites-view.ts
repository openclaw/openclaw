// What owner devices see about invites: the signed cap's public fields, the
// pending request (with the sender details OpenClaw ID reported, display only)
// and how each invite ended. Proof keys never leave the Gateway.
import {
  base64urlToBytes,
  PENDING_REDEMPTION_TTL_SECONDS,
  type InviteAudience,
  type InviteRecord,
  type MemberRole,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { InviteReport, StoredClaw } from "./claw-store.js";
import { isPendingExpired } from "./invite-expiry.js";

/** One invite as listed to owners. */
export type InviteView = {
  inviteId: string;
  label: string;
  role: MemberRole;
  audience: InviteAudience;
  createdAt: number;
  expiresAt: number;
  status: "open" | "pending" | "approved" | "denied" | "expired";
  /** The redemption waiting for an owner decision. */
  pending:
    | {
        accountId: string;
        devicePub: string;
        peerKey: string;
        requestedAt: number;
        /** When the request lapses without a decision (seven days). */
        decideBy: number;
        /** Reported by OpenClaw ID; display only. */
        reported: { email: string | null; displayName: string | null; locationHint: string | null };
      }
    | undefined;
};

// The status an owner sees. A lapsed request reads as expired even before the
// next write sweeps it; a consumed invite shows how it ended.
function inviteStatus(invite: InviteRecord, report: InviteReport | undefined, now: number) {
  if (isPendingExpired(invite, now)) {
    return "expired";
  }
  if (invite.status === "pending" && invite.pending) {
    return "pending";
  }
  if (invite.status === "consumed") {
    return report?.resolution ?? "denied";
  }
  return invite.cap.expires_at <= now ? "expired" : "open";
}

// One invite as listed to owners.
function describeInvite(
  inviteId: string,
  invite: InviteRecord,
  report: InviteReport | undefined,
  now: number,
): InviteView {
  const status = inviteStatus(invite, report, now);
  const pending = status === "pending" ? invite.pending : null;
  return {
    inviteId,
    label: invite.cap.label,
    role: invite.cap.role,
    audience: invite.cap.audience,
    createdAt: invite.cap.created_at,
    expiresAt: invite.cap.expires_at,
    status,
    pending: pending
      ? {
          accountId: pending.account_id,
          devicePub: pending.device_pub,
          peerKey: pending.peer_key,
          requestedAt: pending.requested_at,
          decideBy: pending.requested_at + PENDING_REDEMPTION_TTL_SECONDS,
          reported: {
            email: report?.email ?? null,
            displayName: report?.display_name ?? null,
            locationHint: report?.location_hint ?? null,
          },
        }
      : undefined,
  };
}

/** Lists every invite of a linked claw, newest first, with its status as of `now`. */
export function listInviteViews(record: StoredClaw | undefined, now: number): InviteView[] {
  const state = record?.authority;
  if (!state) {
    return [];
  }
  return Object.entries(state.invites)
    .map(([inviteId, invite]) =>
      describeInvite(inviteId, invite, record.invite_reports?.[inviteId], now),
    )
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

/** Decodes a 32-byte base64url invite proof key, or undefined when malformed. */
export function decodeInviteProofKey(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const bytes = base64urlToBytes(value);
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}
