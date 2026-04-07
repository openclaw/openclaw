import type { OpenClawConfig } from "../../config/config.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  authorizeConfigWriteShared,
  canBypassConfigWritePolicyShared,
  formatConfigWriteDeniedMessageShared,
  resolveChannelConfigWritesShared,
  resolveConfigWriteTargetFromPathShared,
  resolveExplicitConfigWriteTargetShared,
  type ConfigWriteAuthorizationResultLike,
  type ConfigWriteScopeLike,
  type ConfigWriteTargetLike,
} from "./config-write-policy-shared.js";
import type { ChannelId } from "./types.js";
export type ConfigWriteScope = ConfigWriteScopeLike<ChannelId>;
export type ConfigWriteTarget = ConfigWriteTargetLike<ChannelId>;
export type ConfigWriteAuthorizationResult = ConfigWriteAuthorizationResultLike<ChannelId>;

export function resolveChannelConfigWrites(params: {
  cfg: OpenClawConfig;
  channelId?: ChannelId | null;
  accountId?: string | null;
}): boolean {
  return resolveChannelConfigWritesShared(params);
}

export function authorizeConfigWrite(params: {
  cfg: OpenClawConfig;
  origin?: ConfigWriteScope;
  target?: ConfigWriteTarget;
  allowBypass?: boolean;
}): ConfigWriteAuthorizationResult {
  return authorizeConfigWriteShared(params);
}

export function resolveExplicitConfigWriteTarget(scope: ConfigWriteScope): ConfigWriteTarget {
  return resolveExplicitConfigWriteTargetShared(scope);
}

export function resolveConfigWriteTargetFromPath(path: string[]): ConfigWriteTarget {
  return resolveConfigWriteTargetFromPathShared({
    path,
    normalizeChannelId: (raw) => raw.trim().toLowerCase() as ChannelId,
  });
}

export function canBypassConfigWritePolicy(params: {
  channel?: string | null;
  gatewayClientScopes?: string[] | null;
}): boolean {
  return canBypassConfigWritePolicyShared({
    ...params,
    isInternalMessageChannel,
  });
}

export function formatConfigWriteDeniedMessage(params: {
  result: Exclude<ConfigWriteAuthorizationResult, { allowed: true }>;
  fallbackChannelId?: ChannelId | null;
}): string {
  return formatConfigWriteDeniedMessageShared(params);
}
