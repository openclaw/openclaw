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

export function resolveConfigWriteTargetFromPath(path: string[]): ConfigWriteTarget {
  return resolveConfigWriteTargetFromPathShared({
    path,
    normalizeChannelId: normalizeLowercaseStringOrEmpty,
  });
}

export function canBypassConfigWritePolicy(params: {
  channel?: string | null;
  gatewayClientScopes?: string[] | null;
}): boolean {
  return canBypassConfigWritePolicyShared({
    ...params,
    isInternalMessageChannel: (channel) => normalizeLowercaseStringOrEmpty(channel) === "webchat",
  });
}
