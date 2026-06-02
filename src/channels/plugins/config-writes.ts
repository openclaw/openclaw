import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import type { ChannelId } from "./types.core.js";

/** Channel/account scope used by channel plugin config-write checks. */
export type ConfigWriteScope = ConfigWriteScopeLike;
/** Normalized config-write target used by channel plugin callers. */
export type ConfigWriteTarget = ConfigWriteTargetLike;
/** Authorization result for channel-initiated config writes. */
export type ConfigWriteAuthorizationResult = ConfigWriteAuthorizationResultLike;

function isInternalConfigWriteMessageChannel(channel?: string | null): boolean {
  return normalizeLowercaseStringOrEmpty(channel) === "webchat";
}

/** Resolves whether config writes are enabled for a channel/account. */
export function resolveChannelConfigWrites(params: {
  cfg: OpenClawConfig;
  channelId?: ChannelId | null;
  accountId?: string | null;
}): boolean {
  return resolveChannelConfigWritesShared(params);
}

/** Authorizes a config write against origin and resolved target scopes. */
export function authorizeConfigWrite(params: {
  cfg: OpenClawConfig;
  origin?: ConfigWriteScope;
  target?: ConfigWriteTarget;
  allowBypass?: boolean;
}): ConfigWriteAuthorizationResult {
  return authorizeConfigWriteShared(params);
}

/** Converts an explicit channel/account scope into a config-write target. */
export function resolveExplicitConfigWriteTarget(scope: ConfigWriteScope): ConfigWriteTarget {
  return resolveExplicitConfigWriteTargetShared(scope);
}

/** Infers the config-write target touched by a config path. */
export function resolveConfigWriteTargetFromPath(path: string[]): ConfigWriteTarget {
  return resolveConfigWriteTargetFromPathShared({
    path,
    normalizeChannelId: (raw) => normalizeLowercaseStringOrEmpty(raw) as ChannelId,
  });
}

/** Allows internal webchat operator-admin messages to bypass channel config-write policy. */
export function canBypassConfigWritePolicy(params: {
  channel?: string | null;
  gatewayClientScopes?: string[] | null;
}): boolean {
  return canBypassConfigWritePolicyShared({
    ...params,
    isInternalMessageChannel: isInternalConfigWriteMessageChannel,
  });
}

/** Formats a user-facing denial message for config-write policy failures. */
export function formatConfigWriteDeniedMessage(params: {
  result: Exclude<ConfigWriteAuthorizationResult, { allowed: true }>;
  fallbackChannelId?: ChannelId | null;
}): string {
  return formatConfigWriteDeniedMessageShared(params);
}
