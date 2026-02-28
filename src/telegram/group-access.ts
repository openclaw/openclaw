import type { OpenClawConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import { resolveOpenProviderRuntimeGroupPolicy } from "../config/runtime-group-policy.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { isSenderAllowed, type NormalizedAllowFrom } from "./bot-access.js";
import { firstDefined } from "./bot-access.js";

export type TelegramGroupBaseBlockReason =
  | "group-disabled"
  | "topic-disabled"
  | "group-override-unauthorized";

export type TelegramGroupBaseAccessResult =
  | { allowed: true }
  | { allowed: false; reason: TelegramGroupBaseBlockReason };

export const evaluateTelegramGroupBaseAccess = (params: {
  isGroup: boolean;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  hasGroupAllowOverride: boolean;
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  enforceAllowOverride: boolean;
  requireSenderForAllowOverride: boolean;
}): TelegramGroupBaseAccessResult => {
  if (!params.isGroup) {
    return { allowed: true };
  }
  if (params.groupConfig?.enabled === false) {
    return { allowed: false, reason: "group-disabled" };
  }
  if (params.topicConfig?.enabled === false) {
    return { allowed: false, reason: "topic-disabled" };
  }
  if (!params.enforceAllowOverride || !params.hasGroupAllowOverride) {
    return { allowed: true };
  }

  // Explicit per-group/topic allowFrom override must fail closed when empty.
  if (!params.effectiveGroupAllow.hasEntries) {
    return { allowed: false, reason: "group-override-unauthorized" };
  }

  const senderId = params.senderId ?? "";
  if (params.requireSenderForAllowOverride && !senderId) {
    return { allowed: false, reason: "group-override-unauthorized" };
  }

  const allowed = isSenderAllowed({
    allow: params.effectiveGroupAllow,
    senderId,
    senderUsername: params.senderUsername ?? "",
  });
  if (!allowed) {
    return { allowed: false, reason: "group-override-unauthorized" };
  }
  return { allowed: true };
};

export type TelegramGroupPolicyBlockReason =
  | "group-policy-disabled"
  | "group-policy-allowlist-no-sender"
  | "group-policy-allowlist-empty"
  | "group-policy-allowlist-unauthorized"
  | "group-chat-not-allowed";

export type TelegramGroupPolicyAccessResult =
  | { allowed: true; groupPolicy: "open" | "disabled" | "allowlist" }
  | {
      allowed: false;
      reason: TelegramGroupPolicyBlockReason;
      groupPolicy: "open" | "disabled" | "allowlist";
    };

export const resolveTelegramRuntimeGroupPolicy = (params: {
  providerConfigPresent: boolean;
  groupPolicy?: TelegramAccountConfig["groupPolicy"];
  defaultGroupPolicy?: TelegramAccountConfig["groupPolicy"];
}) =>
  resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });

export const evaluateTelegramGroupPolicyAccess = (params: {
  isGroup: boolean;
  chatId: string | number;
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  topicConfig?: TelegramTopicConfig;
  groupConfig?: TelegramGroupConfig;
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  enforcePolicy: boolean;
  useTopicAndGroupOverrides: boolean;
  enforceAllowlistAuthorization: boolean;
  allowEmptyAllowlistEntries: boolean;
  requireSenderForAllowlistAuthorization: boolean;
  checkChatAllowlist: boolean;
}): TelegramGroupPolicyAccessResult => {
  const { groupPolicy: runtimeFallbackPolicy } = resolveTelegramRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.telegram !== undefined,
    groupPolicy: params.telegramCfg.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const fallbackPolicy =
    firstDefined(params.telegramCfg.groupPolicy, params.cfg.channels?.defaults?.groupPolicy) ??
    runtimeFallbackPolicy;
  const groupPolicy = params.useTopicAndGroupOverrides
    ? (firstDefined(
        params.topicConfig?.groupPolicy,
        params.groupConfig?.groupPolicy,
        params.telegramCfg.groupPolicy,
        params.cfg.channels?.defaults?.groupPolicy,
      ) ?? runtimeFallbackPolicy)
    : fallbackPolicy;

  if (!params.isGroup || !params.enforcePolicy) {
    return { allowed: true, groupPolicy };
  }
  if (groupPolicy === "disabled") {
    return { allowed: false, reason: "group-policy-disabled", groupPolicy };
  }
  if (groupPolicy === "allowlist" && params.enforceAllowlistAuthorization) {
    const senderId = params.senderId ?? "";
    if (params.requireSenderForAllowlistAuthorization && !senderId) {
      return { allowed: false, reason: "group-policy-allowlist-no-sender", groupPolicy };
    }
    if (!params.allowEmptyAllowlistEntries && !params.effectiveGroupAllow.hasEntries) {
      return { allowed: false, reason: "group-policy-allowlist-empty", groupPolicy };
    }
    const senderUsername = params.senderUsername ?? "";
    if (
      !isSenderAllowed({
        allow: params.effectiveGroupAllow,
        senderId,
        senderUsername,
      })
    ) {
      return { allowed: false, reason: "group-policy-allowlist-unauthorized", groupPolicy };
    }
  }
  if (params.checkChatAllowlist) {
    const groupAllowlist = params.resolveGroupPolicy(params.chatId);
    if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
      return { allowed: false, reason: "group-chat-not-allowed", groupPolicy };
    }
  }
  return { allowed: true, groupPolicy };
};
