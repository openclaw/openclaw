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

export type GroupRouteAccessReason =
  | "allowed"
  | "disabled"
  | "empty_allowlist"
  | "route_not_allowlisted"
  | "route_disabled";

export type GroupRouteAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: GroupRouteAccessReason;
};

export type MatchedGroupAccessReason =
  | "allowed"
  | "disabled"
  | "empty_allowlist"
  | "not_allowlisted";

export type MatchedGroupAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: MatchedGroupAccessReason;
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

export function evaluateGroupRouteAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  routeAllowlistConfigured: boolean;
  routeMatched: boolean;
  routeEnabled?: boolean;
}): GroupRouteAccessDecision {
  if (params.groupPolicy === "disabled") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      reason: "disabled",
    };
  }

  if (params.routeMatched && params.routeEnabled === false) {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      reason: "route_disabled",
    };
  }

  if (params.groupPolicy === "allowlist") {
    if (!params.routeAllowlistConfigured) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "empty_allowlist",
      };
    }
    if (!params.routeMatched) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "route_not_allowlisted",
      };
    }
  }

  return {
    allowed: true,
    groupPolicy: params.groupPolicy,
    reason: "allowed",
  };
}

export function evaluateMatchedGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  allowlistConfigured: boolean;
  allowlistMatched: boolean;
}): MatchedGroupAccessDecision {
  if (params.groupPolicy === "disabled") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      reason: "disabled",
    };
  }

  if (params.groupPolicy === "allowlist") {
    if (!params.allowlistConfigured) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "empty_allowlist",
      };
    }
    if (!params.allowlistMatched) {
      return {
        allowed: false,
        groupPolicy: params.groupPolicy,
        reason: "not_allowlisted",
      };
    }
  }

  return {
    allowed: true,
    groupPolicy: params.groupPolicy,
    reason: "allowed",
  };
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
