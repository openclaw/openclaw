import type { OpenClawConfig } from "../../config/config.js";
import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import type { ChannelId } from "./types.js";

type ChannelConfigWithAccounts = {
  configWrites?: boolean;
  accounts?: Record<string, { configWrites?: boolean }>;
};

function resolveAccountConfig(accounts: ChannelConfigWithAccounts["accounts"], accountId: string) {
  return resolveAccountEntry(accounts, accountId);
}

export type ConfigWriteScope = {
  channelId?: ChannelId | null;
  accountId?: string | null;
};

export type ConfigWriteAuthorizationResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "ambiguous-target" | "origin-disabled" | "target-disabled";
      blockedScope?: { kind: "origin" | "target"; scope: ConfigWriteScope };
    };

export function resolveChannelConfigWrites(params: {
  cfg: OpenClawConfig;
  channelId?: ChannelId | null;
  accountId?: string | null;
}): boolean {
  if (!params.channelId) {
    return true;
  }
  const channels = params.cfg.channels as Record<string, ChannelConfigWithAccounts> | undefined;
  const channelConfig = channels?.[params.channelId];
  if (!channelConfig) {
    return true;
  }
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = resolveAccountConfig(channelConfig.accounts, accountId);
  const value = accountConfig?.configWrites ?? channelConfig.configWrites;
  return value !== false;
}

export function authorizeConfigWrite(params: {
  cfg: OpenClawConfig;
  origin?: ConfigWriteScope;
  targets?: ConfigWriteScope[];
  allowBypass?: boolean;
  hasAmbiguousTarget?: boolean;
}): ConfigWriteAuthorizationResult {
  if (params.allowBypass) {
    return { allowed: true };
  }
  if (params.hasAmbiguousTarget) {
    return { allowed: false, reason: "ambiguous-target" };
  }
  if (
    params.origin?.channelId &&
    !resolveChannelConfigWrites({
      cfg: params.cfg,
      channelId: params.origin.channelId,
      accountId: params.origin.accountId,
    })
  ) {
    return {
      allowed: false,
      reason: "origin-disabled",
      blockedScope: { kind: "origin", scope: params.origin },
    };
  }
  const seen = new Set<string>();
  for (const target of params.targets ?? []) {
    if (!target.channelId) {
      continue;
    }
    const key = `${target.channelId}:${normalizeAccountId(target.accountId)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (
      !resolveChannelConfigWrites({
        cfg: params.cfg,
        channelId: target.channelId,
        accountId: target.accountId,
      })
    ) {
      return {
        allowed: false,
        reason: "target-disabled",
        blockedScope: { kind: "target", scope: target },
      };
    }
  }
  return { allowed: true };
}

export function resolveConfigWriteScopesFromPath(path: string[]): {
  targets: ConfigWriteScope[];
  hasAmbiguousTarget: boolean;
} {
  if (path[0] !== "channels") {
    return { targets: [], hasAmbiguousTarget: false };
  }
  if (path.length < 2) {
    return { targets: [], hasAmbiguousTarget: true };
  }
  const channelId = path[1].trim().toLowerCase() as ChannelId;
  if (!channelId) {
    return { targets: [], hasAmbiguousTarget: true };
  }
  if (path.length === 2) {
    return { targets: [{ channelId }], hasAmbiguousTarget: true };
  }
  if (path[2] !== "accounts") {
    return { targets: [{ channelId }], hasAmbiguousTarget: false };
  }
  if (path.length < 4) {
    return { targets: [{ channelId }], hasAmbiguousTarget: true };
  }
  return {
    targets: [{ channelId, accountId: normalizeAccountId(path[3]) }],
    hasAmbiguousTarget: false,
  };
}
