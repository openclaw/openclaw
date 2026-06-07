/**
 * Direct-message allowlist audit state.
 *
 * Merges configured and persisted allowFrom entries for setup/status prompts.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { ChannelId } from "../plugins/types.public.js";
import { readChannelIngressStoreAllowFromForDmPolicy } from "./store-allow-from.js";

function readDmAllowAuditEntryValue(entry: unknown): string | number | undefined {
  if (typeof entry === "string" || typeof entry === "number") {
    return entry;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const number = (entry as Record<string, unknown>).number;
  return typeof number === "string" || typeof number === "number" ? number : undefined;
}

export function normalizeDmAllowAuditEntries(
  entries: readonly unknown[] | null | undefined,
): string[] {
  return normalizeStringEntries(
    (entries ?? []).map(readDmAllowAuditEntryValue).filter((entry) => entry != null),
  );
}

export async function resolveDmAllowAuditState(params: {
  provider: ChannelId;
  accountId: string;
  allowFrom?: readonly unknown[] | null;
  dmPolicy?: string | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
  configAllowFrom: string[];
  hasWildcard: boolean;
  allowCount: number;
  isMultiUserDm: boolean;
}> {
  const configAllowFrom = normalizeDmAllowAuditEntries(params.allowFrom);
  const hasWildcard = configAllowFrom.includes("*");
  const storeAllowFrom = await readChannelIngressStoreAllowFromForDmPolicy({
    provider: params.provider,
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    readStore: params.readStore,
  });
  const normalizeEntry = params.normalizeEntry ?? ((value: string) => value);
  const normalizedCfg = normalizeStringEntries(
    configAllowFrom.filter((value) => value !== "*").map((value) => normalizeEntry(value)),
  );
  const normalizedStore = normalizeStringEntries(
    storeAllowFrom.map((value) => normalizeEntry(value)),
  );
  const allowCount = new Set([...normalizedCfg, ...normalizedStore]).size;
  return {
    configAllowFrom,
    hasWildcard,
    allowCount,
    isMultiUserDm: hasWildcard || allowCount > 1,
  };
}