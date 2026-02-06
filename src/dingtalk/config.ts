import type { OpenClawConfig } from "../config/config.js";
import type { DmPolicy, GroupPolicy } from "../config/types.base.js";
import type { DingTalkGroupConfig } from "../config/types.dingtalk.js";

const firstDefined = <T>(...values: Array<T | undefined>) => {
  for (const value of values) {
    if (typeof value !== "undefined") {
      return value;
    }
  }
  return undefined;
};

export type ResolvedDingTalkConfig = {
  enabled: boolean;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  historyLimit: number;
  dmHistoryLimit: number;
  textChunkLimit: number;
  chunkMode: "length" | "newline";
  blockStreaming: boolean;
  streaming: boolean;
  mediaMaxMb: number;
  enableMediaUpload: boolean;
  systemPrompt: string;
  sessionTimeoutMs: number;
  aiCardTemplateId?: string;
  groups: Record<string, DingTalkGroupConfig>;
};

export function resolveDingTalkConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedDingTalkConfig {
  const { cfg, accountId } = params;
  const dtCfg = cfg.channels?.dingtalk;
  const accountCfg = accountId ? dtCfg?.accounts?.[accountId] : undefined;
  const defaults = cfg.channels?.defaults;

  return {
    enabled: firstDefined(accountCfg?.enabled, dtCfg?.enabled, true) ?? true,
    dmPolicy: firstDefined(accountCfg?.dmPolicy, dtCfg?.dmPolicy) ?? "open",
    groupPolicy:
      firstDefined(accountCfg?.groupPolicy, dtCfg?.groupPolicy, defaults?.groupPolicy) ??
      "open",
    allowFrom: (accountCfg?.allowFrom ?? dtCfg?.allowFrom ?? []).map(String),
    groupAllowFrom: (accountCfg?.groupAllowFrom ?? dtCfg?.groupAllowFrom ?? []).map(String),
    historyLimit: firstDefined(accountCfg?.historyLimit, dtCfg?.historyLimit) ?? 10,
    dmHistoryLimit: firstDefined(accountCfg?.dmHistoryLimit, dtCfg?.dmHistoryLimit) ?? 20,
    textChunkLimit: firstDefined(accountCfg?.textChunkLimit, dtCfg?.textChunkLimit) ?? 4000,
    chunkMode: firstDefined(accountCfg?.chunkMode, dtCfg?.chunkMode) ?? "length",
    blockStreaming: firstDefined(accountCfg?.blockStreaming, dtCfg?.blockStreaming) ?? false,
    streaming: firstDefined(accountCfg?.streaming, dtCfg?.streaming) ?? true,
    mediaMaxMb: firstDefined(accountCfg?.mediaMaxMb, dtCfg?.mediaMaxMb) ?? 20,
    // Media upload is always enabled for DingTalk; disable toggle removed.
    enableMediaUpload: true,
    systemPrompt: firstDefined(accountCfg?.systemPrompt, dtCfg?.systemPrompt) ?? "",
    sessionTimeoutMs: firstDefined(accountCfg?.sessionTimeoutMs, dtCfg?.sessionTimeoutMs) ??
      30 * 60 * 1000,
    aiCardTemplateId: firstDefined(accountCfg?.aiCardTemplateId, dtCfg?.aiCardTemplateId),
    groups: { ...dtCfg?.groups, ...accountCfg?.groups },
  };
}

export function resolveDingTalkGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  chatId: string;
}): { groupConfig?: DingTalkGroupConfig } {
  const resolved = resolveDingTalkConfig({ cfg: params.cfg, accountId: params.accountId });
  const groupConfig = resolved.groups[params.chatId];
  return { groupConfig };
}

export function resolveDingTalkGroupRequireMention(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  chatId: string;
}): boolean {
  const { groupConfig } = resolveDingTalkGroupConfig(params);
  return groupConfig?.requireMention ?? true;
}

export function resolveDingTalkGroupEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  chatId: string;
}): boolean {
  const { groupConfig } = resolveDingTalkGroupConfig(params);
  return groupConfig?.enabled ?? true;
}
