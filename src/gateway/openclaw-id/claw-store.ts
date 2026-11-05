// Durable OpenClaw ID claw record in the shared state database (core-owned
// plugin-state namespace). The Gateway is the only writer: it loads the record
// once and writes through on every accepted change.
import type {
  AuthorityState,
  SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createCorePluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import type { DeviceTokenBinding } from "./device-token-binding.js";

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
   * own row (see writeStoredClaw), so neither row outgrows the plugin-state value limit.
   */
  token_bindings?: DeviceTokenBinding[];
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

/** Sender details OpenClaw ID reported for a redemption, and the invite's outcome. */
export type InviteReport = {
  /** The redeeming account (from the signed redemption). */
  account_id?: string;
  email: string | null;
  display_name: string | null;
  location_hint: string | null;
  resolution?: "approved" | "denied" | "expired";
  resolved_at?: number;
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

/** Keeps verified display claims JSON-safe without retaining missing fields or token metadata. */
export function storedOwnerProfile(
  account: OpenClawIdAccount,
): NonNullable<StoredClaw["owner_profile"]> {
  return {
    sub: account.sub,
    ...(typeof account.email === "string" ? { email: account.email } : {}),
    ...(typeof account.name === "string" ? { name: account.name } : {}),
  };
}

const RECORD_KEY = "current";
const TOKEN_BINDINGS_KEY = "token-bindings";

/** The device-token bindings row, kept beside the claw record. */
export type StoredTokenBindings = { v: 1; bindings: DeviceTokenBinding[] };

function openStore<T>() {
  return createCorePluginStateKeyedStore<T>({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
  });
}

/**
 * Splits the claw record into its two stored rows: the record without its token bindings,
 * and the bindings. At every protocol cap each row stays within the plugin-state value limit,
 * which the record as one value would not.
 */
export function clawStoreRows(record: StoredClaw): {
  claw: StoredClaw;
  tokenBindings: StoredTokenBindings;
} {
  const { token_bindings: bindings, ...claw } = record;
  return { claw, tokenBindings: { v: 1, bindings: bindings ?? [] } };
}

/**
 * Reads the claw record, or undefined before the first link attempt. The bindings row wins
 * over bindings still inside a record written before they had their own row; the next write
 * moves them out.
 */
export async function readStoredClaw(): Promise<StoredClaw | undefined> {
  const [record, bindings] = await Promise.all([
    openStore<StoredClaw>().lookup(RECORD_KEY),
    openStore<StoredTokenBindings>().lookup(TOKEN_BINDINGS_KEY),
  ]);
  if (!record || !bindings) {
    return record;
  }
  return { ...record, token_bindings: bindings.bindings };
}

/**
 * Replaces the claw record. The bindings row is written before the record row. Apart from
 * moving bindings out of an older record, a write changes only one of the two, so an
 * interrupted write leaves the rows as they were or with only its own change.
 */
export async function writeStoredClaw(record: StoredClaw): Promise<void> {
  const rows = clawStoreRows(record);
  await openStore<StoredTokenBindings>().register(TOKEN_BINDINGS_KEY, rows.tokenBindings);
  await openStore<StoredClaw>().register(RECORD_KEY, rows.claw);
}
