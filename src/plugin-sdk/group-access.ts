import { resolveOpenProviderRuntimeGroupPolicy } from "../config/runtime-group-policy.js";
import type { GroupPolicy } from "../config/types.base.js";

export type SenderGroupAccessReason =
  | "allowed"
  | "disabled"
  | "empty_allowlist"
  | "sender_not_allowlisted";

export type SenderGroupAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
  reason: SenderGroupAccessReason;
};

export function resolveSenderScopedGroupPolicy(params: {
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
}): GroupPolicy {
  if (params.groupPolicy === "disabled") {
    return "disabled";
  }
  return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}

export function evaluateSenderGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied?: boolean;
  groupAllowFrom: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision {
  if (params.groupPolicy === "disabled") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
      reason: "disabled",
    };
  }
  if (params.groupPolicy === "allowlist") {
    if (params.groupAllowFrom.length === 0) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
        reason: "empty_allowlist",
      };
    }
    if (!params.isSenderAllowed(params.senderId, params.groupAllowFrom)) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
        reason: "sender_not_allowlisted",
      };
    }
  }

  return {
    allowed: true,
    groupPolicy: params.groupPolicy,
    providerMissingFallbackApplied: Boolean(params.providerMissingFallbackApplied),
    reason: "allowed",
  };
}

export function evaluateSenderGroupAccess(params: {
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  groupAllowFrom: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision {
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.configuredGroupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });

  return evaluateSenderGroupAccessForPolicy({
    groupPolicy,
    providerMissingFallbackApplied,
    groupAllowFrom: params.groupAllowFrom,
    senderId: params.senderId,
    isSenderAllowed: params.isSenderAllowed,
  });
}
