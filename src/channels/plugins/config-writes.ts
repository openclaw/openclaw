import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  authorizeConfigWriteShared,
  canBypassConfigWritePolicyShared,
  formatConfigWriteDeniedMessageShared,
  resolveConfigWriteTargetFromPathShared,
  resolveExplicitConfigWriteTargetShared,
  type ConfigWriteAuthorizationResultLike,
  type ConfigWriteScopeLike,
  type ConfigWriteTargetLike,
} from "./config-write-policy-shared.js";

/**
 * Target affected by a channel config write.
 */
export type ConfigWriteTarget = ConfigWriteTargetLike;

export const authorizeConfigWrite: (params: {
  cfg: OpenClawConfig;
  origin?: ConfigWriteScopeLike;
  target?: ConfigWriteTarget;
  allowBypass?: boolean;
}) => ConfigWriteAuthorizationResultLike = authorizeConfigWriteShared;

export const resolveExplicitConfigWriteTarget: (scope: ConfigWriteScopeLike) => ConfigWriteTarget =
  resolveExplicitConfigWriteTargetShared;

export const formatConfigWriteDeniedMessage: (params: {
  result: Exclude<ConfigWriteAuthorizationResultLike, { allowed: true }>;
  fallbackChannelId?: string | null;
}) => string = formatConfigWriteDeniedMessageShared;

/**
 * Infers the channel config write target from a config path.
 */
export function resolveConfigWriteTargetFromPath(path: string[]): ConfigWriteTarget {
  return resolveConfigWriteTargetFromPathShared({
    path,
    normalizeChannelId: normalizeLowercaseStringOrEmpty,
  });
}

/**
 * Checks whether a gateway client can bypass channel config write policy.
 */
export function canBypassConfigWritePolicy(params: {
  channel?: string | null;
  gatewayClientScopes?: string[] | null;
}): boolean {
  return canBypassConfigWritePolicyShared({
    ...params,
    isInternalMessageChannel: (channel) => normalizeLowercaseStringOrEmpty(channel) === "webchat",
  });
}
