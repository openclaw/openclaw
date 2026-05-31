import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { hasConfiguredUnavailableCredentialStatus } from "../account-snapshot-fields.js";
import type { ChannelAccountSnapshot } from "../plugins/types.public.js";

export type RuntimeChannelStatusPayload = {
  channelAccounts?: unknown;
};

export type RuntimeChannelAccount = Record<string, unknown>;

const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

function readRuntimeAccountsByChannel(payload: unknown): Record<string, unknown> {
  return asRecord(asRecord(payload).channelAccounts);
}

/** Return live runtime account objects for one channel from a gateway payload. */
export function getRuntimeChannelAccounts(params: {
  payload: unknown;
  channelId: string;
}): RuntimeChannelAccount[] {
  const raw = readRuntimeAccountsByChannel(params.payload)[params.channelId];
  return Array.isArray(raw) ? raw.map(asRecord) : [];
}

/** Normalize gateway channel account snapshots into a channel-keyed lookup map. */
export function normalizeRuntimeChannelAccountSnapshots(
  payload: unknown,
): Map<string, ChannelAccountSnapshot[]> {
  const out = new Map<string, ChannelAccountSnapshot[]>();
  for (const [channelId, accounts] of Object.entries(readRuntimeAccountsByChannel(payload))) {
    if (!Array.isArray(accounts)) {
      continue;
    }
    const normalized = accounts.filter(
      (account): account is ChannelAccountSnapshot =>
        Boolean(account) &&
        typeof account === "object" &&
        typeof (account as { accountId?: unknown }).accountId === "string",
    );
    if (normalized.length > 0) {
      out.set(channelId, normalized);
    }
  }
  return out;
}

/** Resolve the account id used to correlate runtime and config account rows. */
export function resolveRuntimeChannelAccountId(account: RuntimeChannelAccount): string {
  return (
    normalizeOptionalString(account.accountId) ??
    normalizeOptionalString(account.id) ??
    normalizeOptionalString(account.name) ??
    DEFAULT_ACCOUNT_ID
  );
}

/** Find the live runtime account matching a config account id. */
export function findRuntimeChannelAccount(params: {
  liveAccounts: RuntimeChannelAccount[];
  accountId: string;
}): RuntimeChannelAccount | null {
  return (
    params.liveAccounts.find(
      (account) => resolveRuntimeChannelAccountId(account) === params.accountId,
    ) ??
    (params.accountId === DEFAULT_ACCOUNT_ID && params.liveAccounts.length === 1
      ? (params.liveAccounts[0] ?? null)
      : null)
  );
}

/** Treat running/connected runtime accounts as proof that credentials are usable. */
export function hasRuntimeCredentialAvailable(params: {
  liveAccounts: RuntimeChannelAccount[];
  accountId: string;
}): boolean {
  const account = findRuntimeChannelAccount(params);
  if (!account) {
    return false;
  }
  if (hasConfiguredUnavailableCredentialStatus(account)) {
    return false;
  }
  return account.running === true || account.connected === true;
}

/** Upgrade credential status snapshots when live runtime proof shows availability. */
export function markConfiguredUnavailableCredentialStatusesAvailable(
  account: unknown,
): Record<string, unknown> {
  const record = { ...asRecord(account) };
  for (const key of CREDENTIAL_STATUS_KEYS) {
    if (record[key] === "configured_unavailable") {
      record[key] = "available";
    }
  }
  return record;
}

/** Merge configured and gateway-reported accounts into display rows. */
export async function resolveChannelAccountStatusRows(params: {
  localAccountIds: string[];
  runtimeAccounts: ChannelAccountSnapshot[];
  resolveLocalSnapshot: (accountId: string) => Promise<ChannelAccountSnapshot>;
}): Promise<
  Array<{
    accountId: string;
    snapshot: ChannelAccountSnapshot;
    source: "gateway" | "config";
  }>
> {
  const mergedAccountIds = uniqueStrings([
    ...params.localAccountIds,
    ...params.runtimeAccounts.map((account) => account.accountId),
  ]);
  const rows: Array<{
    accountId: string;
    snapshot: ChannelAccountSnapshot;
    source: "gateway" | "config";
  }> = [];
  for (const accountId of mergedAccountIds) {
    const runtimeSnapshot = params.runtimeAccounts.find(
      (account) => account.accountId === accountId,
    );
    rows.push({
      accountId,
      snapshot: runtimeSnapshot ?? (await params.resolveLocalSnapshot(accountId)),
      source: runtimeSnapshot ? "gateway" : "config",
    });
  }
  return rows;
}
