// Durable OpenClaw ID claw record in the shared state database (core-owned
// plugin-state namespace). The Gateway is the only writer: it loads the record
// once and writes through on every accepted change.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  AuthorityState,
  SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { prepareCorePluginStateReplacement } from "../../plugin-state/plugin-state-store.js";
import type { DeviceTokenBinding } from "./device-token-binding.js";
import type { MemberRecoveryUse } from "./member-recovery-use-contract.js";

/** The signed-in account the Gateway's verified sign-in reports. */
export type OpenClawIdAccount = {
  sub: string;
  email: string | null;
  name: string | null;
  /** ID token expiry, seconds since the epoch. */
  exp: number;
};

/** Everything the Gateway keeps about its claw. */
export type StoredClaw = {
  v: 1;
  /** 128 random bits, hex; created on first verified sign-in or "Make reachable". */
  claw_id: string;
  /** `<name>-<account tag>.<loaderDomain>`, fixed at link time (the binding is signed for it). */
  hostname: string | null;
  /** Membership authority; null until the claw is linked. */
  authority: AuthorityState | null;
  /** Server-redeemed OIDC display claims; usable only for the linked owner subject. */
  owner_profile?: { sub: string; email?: string; name?: string };
  /** The current ServerBinding, signed by R or an owner device. */
  binding: SignedStatement<"ServerBinding"> | null;
  /**
   * What OpenClaw ID reported about each invite redemption (display only, never
   * authority) and how the invite ended, keyed by invite id.
   */
  invite_reports?: Record<string, InviteReport>;
  /**
   * Device tokens issued over the tunnel and the device key W each belongs to. Stored in their
   * own row alongside the partitioned authority (see writeStoredClaw).
   */
  token_bindings?: DeviceTokenBinding[];
  /** Gateway approval times, bounded by current membership rather than invite lifetime. */
  member_approved_at?: Record<string, number | null>;
  /** Members whose profile role was initialized; clearing a role must not rerun migration. */
  member_profile_roles?: Record<string, boolean>;
  /** Display-only browser notices and bounded replay/rate receipts for current members. */
  member_browser_requests?: Record<string, MemberBrowserRequestState>;
  /** Accepted kit-use evidence; retained after kit, browser, and member removal. */
  member_recovery_uses?: MemberRecoveryUse[];
  /** Discovery publication state (a mirror; never authority). */
  discovery: {
    owner_account_id: string | null;
    published_binding_seq: number;
    published_snapshot_seq: number;
    /** A publication was requested and has not succeeded yet (publication-retry.ts). */
    publish_pending?: boolean;
    /** issued_at of the last snapshot Discovery accepted (freshness/v1 re-signs it hourly). */
    published_snapshot_at?: number;
    mailbox_cursor: string | null;
  };
};

/** Display-only: three accepted-ID receipts, three unseen-ID tombstones and one overflow deadline. */
export type MemberBrowserRequestState = {
  notice: {
    requestId: string;
    label: string;
    location: string | null;
    requestedAt: number;
    expiresAt: number;
  } | null;
  recent: Array<{ requestId: string; until: number }>;
  terminal?: Array<{ requestId: string; until: number }>;
  /** Refuse new notices through this deadline when unseen terminal IDs exceed the tombstone cap. */
  blockedUntil?: number | null;
};

/** Sender details OpenClaw ID reported for a redemption, and the invite's outcome. */
export type InviteReport = {
  /** The redeeming account (from the signed redemption). */
  account_id?: string;
  email: string | null;
  display_name: string | null;
  location_hint: string | null;
  resolution?: "approved" | "denied" | "expired";
  resolved_at?: number;
  /** Owner-selected local profile; never part of a signed cap or Discovery publication. */
  existingProfile?: { id: string; displayName: string | null; fallbackReason?: string };
};

/** Refuses recovery if an awaited lookup belongs to a root or binding that has since changed. */
export function assertSameClawIdentity(
  current: StoredClaw | undefined,
  expected: StoredClaw,
): void {
  if (
    current?.binding !== expected.binding ||
    current?.authority?.anchor.root_pub !== expected.authority?.anchor.root_pub
  ) {
    throw new Error("claw identity changed during registration recovery");
  }
}

/** Refuses oversized opaque metadata without truncating account identities or mailbox cursors. */
export function assertStoredClawText(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "string" || value.length > 256)) {
    throw new Error(`OpenClaw ID ${field} must be null or at most 256 characters`);
  }
}

/** Keeps verified display claims JSON-safe without retaining missing fields or token metadata. */
export function storedOwnerProfile(
  account: OpenClawIdAccount,
): NonNullable<StoredClaw["owner_profile"]> {
  assertStoredClawText(account.sub, "owner account ID");
  return {
    sub: account.sub,
    ...(typeof account.email === "string" ? { email: truncateUtf16Safe(account.email, 256) } : {}),
    ...(typeof account.name === "string" ? { name: truncateUtf16Safe(account.name, 256) } : {}),
  };
}

// The persisted core names its format; all sections are installed atomically beside it.
type StoredClawCore = Omit<
  StoredClaw,
  | "v"
  | "authority"
  | "invite_reports"
  | "token_bindings"
  | "member_approved_at"
  | "member_browser_requests"
  | "member_recovery_uses"
> & {
  v: 2;
  authority: Omit<AuthorityState, "owner_devices" | "members" | "invites"> | null;
};

type ClawRows = {
  current: StoredClawCore;
  "owner-devices": AuthorityState["owner_devices"];
  members: AuthorityState["members"];
  [key: `members:${number}`]: AuthorityState["members"];
  invites: AuthorityState["invites"];
  "invite-reports": NonNullable<StoredClaw["invite_reports"]>;
  "member-approvals": NonNullable<StoredClaw["member_approved_at"]>;
  [key: `member-browser-requests:${number}`]: NonNullable<StoredClaw["member_browser_requests"]>;
  "token-bindings": StoredTokenBindings;
  [key: `member-recovery-use:${number}`]: MemberRecoveryUse;
};
type ClawRow = ClawRows[keyof ClawRows] | StoredClaw;

/** The device-token bindings row, kept beside membership authority. */
type StoredTokenBindings = { v: 1; bindings: DeviceTokenBinding[] };

// The authority is the sole writer; this existing catalog owner binds every row to one store.
function openStore() {
  return prepareCorePluginStateReplacement<ClawRow>({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
  });
}

/** Partitions current authority into bounded values without changing any signed statement. */
export function clawStoreRows(record: StoredClaw): ClawRows {
  const {
    authority,
    invite_reports,
    member_approved_at,
    member_browser_requests,
    token_bindings,
    member_recovery_uses,
    ...core
  } = record;
  let anchor: StoredClawCore["authority"] = null;
  if (authority) {
    const { owner_devices: _owners, members: _members, invites: _invites, ...rest } = authority;
    anchor = rest;
  }
  // Thirty-two accounts with ten maximum-length device labels fit the 1 MiB row limit.
  // All chunks keep the same member-record shape and are replaced in one transaction.
  const memberEntries = Object.entries(authority?.members ?? {});
  const memberRows: Record<string, AuthorityState["members"]> = {};
  for (let offset = 32; offset < memberEntries.length; offset += 32) {
    memberRows[`members:${offset / 32}`] = Object.fromEntries(
      memberEntries.slice(offset, offset + 32),
    );
  }
  const browserRows: Record<string, NonNullable<StoredClaw["member_browser_requests"]>> = {};
  if (member_browser_requests) {
    const entries = Object.entries(member_browser_requests);
    for (let offset = 0; offset < Math.max(entries.length, 1); offset += 32) {
      browserRows[`member-browser-requests:${offset / 32}`] = Object.fromEntries(
        entries.slice(offset, offset + 32),
      );
    }
  }
  return {
    current: { ...core, v: 2, authority: anchor },
    "owner-devices": authority?.owner_devices ?? {},
    members: Object.fromEntries(memberEntries.slice(0, 32)),
    ...memberRows,
    ...browserRows,
    ...Object.fromEntries(
      (member_recovery_uses ?? []).map((use) => [`member-recovery-use:${use.seq}`, use]),
    ),
    invites: authority?.invites ?? {},
    "invite-reports": invite_reports ?? {},
    "member-approvals": member_approved_at ?? {},
    "token-bindings": { v: 1, bindings: token_bindings ?? [] },
  };
}

/** Reads every claw section from one catalog snapshot, or the prior monolithic layout. */
export async function readStoredClaw(): Promise<StoredClaw | undefined> {
  const entries = new Map((await openStore().entries()).map(({ key, value }) => [key, value]));
  // SAFETY: only this module writes current; its v field distinguishes the two persisted layouts.
  const record = entries.get("current") as StoredClawCore | StoredClaw | undefined;
  if (!record) {
    return undefined;
  }
  if (record.v === 1) {
    // The existing bindings row wins, including an empty row after successful revocation.
    // SAFETY: only this module writes token-bindings, always as StoredTokenBindings.
    const bindings = entries.get("token-bindings") as StoredTokenBindings | undefined;
    return bindings ? { ...record, token_bindings: bindings.bindings } : record;
  }
  const section = <Key extends keyof ClawRows>(key: Key): ClawRows[Key] => {
    if (!entries.has(key)) {
      throw new Error(`OpenClaw ID claw storage is incomplete: missing ${key}`);
    }
    // SAFETY: these fixed keys are written together by clawStoreRows under this module's owner.
    return entries.get(key) as ClawRows[Key];
  };
  const recoveryUses = [...entries]
    .filter(([key]) => key.startsWith("member-recovery-use:"))
    // SAFETY: only clawStoreRows writes these evidence rows, atomically with admission.
    .map(([, value]) => value as MemberRecoveryUse)
    .toSorted((a, b) => a.seq - b.seq);
  return {
    ...record,
    v: 1,
    authority: record.authority
      ? {
          ...record.authority,
          owner_devices: section("owner-devices"),
          members: Object.assign(
            {},
            section("members"),
            ...[...entries]
              .filter(([key]) => key.startsWith("members:"))
              // SAFETY: the claw writer stores member records in every members chunk.
              .map(([, value]) => value as AuthorityState["members"]),
          ),
          invites: section("invites"),
        }
      : null,
    invite_reports: section("invite-reports"),
    member_approved_at: section("member-approvals"),
    ...(entries.has("member-browser-requests:0")
      ? {
          member_browser_requests: Object.assign(
            {},
            ...[...entries]
              .filter(([key]) => key.startsWith("member-browser-requests:"))
              // SAFETY: clawStoreRows writes member request records into every browser-request chunk.
              .map(([, value]) => value as NonNullable<StoredClaw["member_browser_requests"]>),
          ),
        }
      : {}),
    ...(recoveryUses.length ? { member_recovery_uses: recoveryUses } : {}),
    token_bindings: section("token-bindings").bindings,
  };
}

/** Replaces all claw sections in the existing state worker's single write transaction. */
export async function writeStoredClaw(
  record: StoredClaw,
  assertCurrent?: () => void,
): Promise<void> {
  await openStore().replace(new Map(Object.entries(clawStoreRows(record))), assertCurrent);
}
