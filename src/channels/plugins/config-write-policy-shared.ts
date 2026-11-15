import { resolveChannelAccountEntry } from "../../routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";

type AccountConfigWithWrites = {
  configWrites?: boolean;
};

type ChannelConfigWithAccounts = {
  configWrites?: boolean;
  accounts?: Record<string, AccountConfigWithWrites>;
};

type ConfigWritePolicyConfig = {
  channels?: Record<string, unknown>;
};

export type ConfigWriteScopeLike<TChannelId extends string = string> = {
  channelId?: TChannelId | null;
  accountId?: string | null;
};

export type ConfigWriteTargetLike<TChannelId extends string = string> =
  | { kind: "global" }
  | { kind: "channel"; scope: { channelId: TChannelId } }
  | { kind: "account"; scope: { channelId: TChannelId; accountId: string } }
  | { kind: "ambiguous"; scopes: ConfigWriteScopeLike<TChannelId>[] };

export type ConfigWriteAuthorizationResultLike<TChannelId extends string = string> =
  | { allowed: true }
  | {
      allowed: false;
      reason: "ambiguous-target" | "origin-disabled" | "target-disabled";
      blockedScope?: {
        kind: "origin" | "target";
        scope: ConfigWriteScopeLike<TChannelId>;
      };
    };

function resolveChannelConfig(
  cfg: ConfigWritePolicyConfig,
  channelId?: string | null,
): ChannelConfigWithAccounts | undefined {
  if (!channelId) {
    return undefined;
  }
  const channelConfig = cfg.channels?.[channelId];
  return channelConfig != null && typeof channelConfig === "object" && !Array.isArray(channelConfig)
    ? (channelConfig as ChannelConfigWithAccounts)
    : undefined;
}

export function resolveChannelConfigWritesShared(params: {
  cfg: ConfigWritePolicyConfig;
  channelId?: string | null;
  accountId?: string | null;
}): boolean {
  const channelConfig = resolveChannelConfig(params.cfg, params.channelId);
  if (!channelConfig || !params.channelId) {
    return true;
  }
  const accountConfig = resolveChannelAccountEntry(
    channelConfig.accounts,
    normalizeAccountId(params.accountId),
    params.channelId,
  );
  const value = accountConfig?.configWrites ?? channelConfig.configWrites;
  return value !== false;
}

export function authorizeConfigWriteShared<TChannelId extends string>(params: {
  cfg: ConfigWritePolicyConfig;
  origin?: ConfigWriteScopeLike<TChannelId>;
  target?: ConfigWriteTargetLike<TChannelId>;
  allowBypass?: boolean;
}): ConfigWriteAuthorizationResultLike<TChannelId> {
  if (params.allowBypass) {
    return { allowed: true };
  }
  if (params.target?.kind === "ambiguous") {
    return { allowed: false, reason: "ambiguous-target" };
  }
  const target = params.target;
  // Check the origin first so denial reporting preserves the initiating boundary.
  const scopes: Array<
    readonly ["origin" | "target", ConfigWriteScopeLike<TChannelId> | undefined]
  > = [
    ["origin", params.origin],
    ["target", target && target.kind !== "global" ? target.scope : undefined],
  ];
  for (const [kind, scope] of scopes) {
    if (
      scope?.channelId &&
      !resolveChannelConfigWritesShared({
        cfg: params.cfg,
        channelId: scope.channelId,
        accountId: scope.accountId,
      })
    ) {
      return {
        allowed: false,
        reason: kind === "origin" ? "origin-disabled" : "target-disabled",
        blockedScope: { kind, scope },
      };
    }
  }
  return { allowed: true };
}

export function resolveExplicitConfigWriteTargetShared<TChannelId extends string>(
  scope: ConfigWriteScopeLike<TChannelId>,
): ConfigWriteTargetLike<TChannelId> {
  if (!scope.channelId) {
    return { kind: "global" };
  }
  const accountId = normalizeAccountId(scope.accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return { kind: "channel", scope: { channelId: scope.channelId } };
  }
  return { kind: "account", scope: { channelId: scope.channelId, accountId } };
}

export function resolveConfigWriteTargetFromPathShared<TChannelId extends string>(params: {
  path: string[];
  normalizeChannelId: (raw: string) => TChannelId | null | undefined;
}): ConfigWriteTargetLike<TChannelId> {
  if (params.path[0] !== "channels") {
    return { kind: "global" };
  }
  if (params.path.length < 2) {
    return { kind: "ambiguous", scopes: [] };
  }
  const channelId = params.normalizeChannelId(params.path[1] ?? "");
  if (!channelId) {
    return { kind: "ambiguous", scopes: [] };
  }
  if (params.path.length === 2) {
    return { kind: "ambiguous", scopes: [{ channelId }] };
  }
  if (params.path[2] !== "accounts") {
    return { kind: "channel", scope: { channelId } };
  }
  if (params.path.length < 4) {
    return { kind: "ambiguous", scopes: [{ channelId }] };
  }
  return resolveExplicitConfigWriteTargetShared({
    channelId,
    accountId: params.path[3],
  });
}

export function canBypassConfigWritePolicyShared(params: {
  channel?: string | null;
  gatewayClientScopes?: string[] | null;
  isInternalMessageChannel: (channel?: string | null) => boolean;
}): boolean {
  return (
    params.isInternalMessageChannel(params.channel) &&
    params.gatewayClientScopes?.includes("operator.admin") === true
  );
}

export function formatConfigWriteDeniedMessageShared<TChannelId extends string>(params: {
  result: Exclude<ConfigWriteAuthorizationResultLike<TChannelId>, { allowed: true }>;
  fallbackChannelId?: TChannelId | null;
}): string {
  if (params.result.reason === "ambiguous-target") {
    return "⚠️ Channel-initiated /config writes cannot replace channels, channel roots, or accounts collections. Use a more specific path or gateway operator.admin.";
  }

  const blocked = params.result.blockedScope?.scope;
  const channelLabel = blocked?.channelId ?? params.fallbackChannelId ?? "this channel";
  const hint = blocked?.channelId
    ? blocked.accountId
      ? `channels.${blocked.channelId}.accounts.${blocked.accountId}.configWrites=true`
      : `channels.${blocked.channelId}.configWrites=true`
    : params.fallbackChannelId
      ? `channels.${params.fallbackChannelId}.configWrites=true`
      : "channels.<channel>.configWrites=true";
  return `⚠️ Config writes are disabled for ${channelLabel}. Set ${hint} to enable.`;
}
