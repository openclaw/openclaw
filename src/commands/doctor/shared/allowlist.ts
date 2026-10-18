import {
  asNullableRecord,
  asOptionalObjectRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { DoctorAllowFromList } from "../types.js";

/** Return true when an allowFrom-like list has at least one normalized sender entry. */
export function hasAllowFromEntries(list?: DoctorAllowFromList) {
  return Array.isArray(list) && normalizeStringEntries(list).length > 0;
}

/** Visit the channel before reading accounts so repairs retain parent-first semantics. */
export function* iterateDoctorChannelAccounts(
  channel: Record<string, unknown>,
  prefix: string,
  skipDisabled = false,
): Generator<{
  account: Record<string, unknown>;
  parent?: Record<string, unknown>;
  accountId?: string;
  prefix: string;
}> {
  yield { account: channel, prefix };
  for (const [accountId, value] of Object.entries(asNullableRecord(channel.accounts) ?? {})) {
    const account = asOptionalObjectRecord(value);
    if (account && (!skipDisabled || account.enabled !== false)) {
      yield { account, parent: channel, accountId, prefix: `${prefix}.accounts.${accountId}` };
    }
  }
}
