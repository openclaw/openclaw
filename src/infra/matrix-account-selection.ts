import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveMatrixChannelConfig(cfg: OpenClawConfig): Record<string, unknown> | null {
  return isRecord(cfg.channels?.matrix) ? cfg.channels.matrix : null;
}

export function findMatrixAccountEntry(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> | null {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return null;
  }

  const accounts = isRecord(channel.accounts) ? channel.accounts : null;
  if (!accounts) {
    return null;
  }

  const normalizedAccountId = normalizeAccountId(accountId);
  for (const [rawAccountId, value] of Object.entries(accounts)) {
    if (normalizeAccountId(rawAccountId) === normalizedAccountId && isRecord(value)) {
      return value;
    }
  }

  return null;
}

export function resolveConfiguredMatrixAccountIds(cfg: OpenClawConfig): string[] {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return [];
  }

  const accounts = isRecord(channel.accounts) ? channel.accounts : null;
  if (!accounts) {
    return [DEFAULT_ACCOUNT_ID];
  }

  const ids = Object.entries(accounts)
    .filter(([, value]) => isRecord(value))
    .map(([accountId]) => normalizeAccountId(accountId));

  return Array.from(new Set(ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID])).toSorted((a, b) =>
    a.localeCompare(b),
  );
}

export function resolveMatrixDefaultOrOnlyAccountId(cfg: OpenClawConfig): string {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return DEFAULT_ACCOUNT_ID;
  }

  const configuredDefault = normalizeOptionalAccountId(
    typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
  );
  const configuredAccountIds = resolveConfiguredMatrixAccountIds(cfg);
  if (configuredDefault && configuredAccountIds.includes(configuredDefault)) {
    return configuredDefault;
  }
  if (configuredAccountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }

  if (configuredAccountIds.length === 1) {
    return configuredAccountIds[0] ?? DEFAULT_ACCOUNT_ID;
  }
  return DEFAULT_ACCOUNT_ID;
}

export function requiresExplicitMatrixDefaultAccount(cfg: OpenClawConfig): boolean {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return false;
  }
  const configuredAccountIds = resolveConfiguredMatrixAccountIds(cfg);
  if (configuredAccountIds.length <= 1) {
    return false;
  }
  const configuredDefault = normalizeOptionalAccountId(
    typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
  );
  return !(configuredDefault && configuredAccountIds.includes(configuredDefault));
}
