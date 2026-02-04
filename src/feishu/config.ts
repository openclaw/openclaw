import type { OpenClawConfig } from "../config/config.js";
import type { DmPolicy, GroupPolicy } from "../config/types.base.js";
import type { FeishuGroupConfig } from "../config/types.feishu.js";
import { firstDefined } from "./access.js";

export type ResolvedFeishuConfig = {
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
  groups: Record<string, FeishuGroupConfig>;
};

/**
 * Resolve effective Feishu configuration for an account.
 * Account-level config overrides top-level feishu config, which overrides channel defaults.
 */
export function resolveFeishuConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedFeishuConfig {
  const { cfg, accountId } = params;
  const feishuCfg = cfg.channels?.feishu;
  const accountCfg = accountId ? feishuCfg?.accounts?.[accountId] : undefined;
  const defaults = cfg.channels?.defaults;

  // Merge with precedence: account > feishu top-level > channel defaults > hardcoded defaults
  return {
    enabled: firstDefined(accountCfg?.enabled, feishuCfg?.enabled, true) ?? true,
    dmPolicy: firstDefined(accountCfg?.dmPolicy, feishuCfg?.dmPolicy) ?? "pairing",
    groupPolicy:
      firstDefined(accountCfg?.groupPolicy, feishuCfg?.groupPolicy, defaults?.groupPolicy) ??
      "open",
    allowFrom: (accountCfg?.allowFrom ?? feishuCfg?.allowFrom ?? []).map(String),
    groupAllowFrom: (accountCfg?.groupAllowFrom ?? feishuCfg?.groupAllowFrom ?? []).map(String),
    historyLimit: firstDefined(accountCfg?.historyLimit, feishuCfg?.historyLimit) ?? 10,
    dmHistoryLimit: firstDefined(accountCfg?.dmHistoryLimit, feishuCfg?.dmHistoryLimit) ?? 20,
    textChunkLimit: firstDefined(accountCfg?.textChunkLimit, feishuCfg?.textChunkLimit) ?? 2000,
    chunkMode: firstDefined(accountCfg?.chunkMode, feishuCfg?.chunkMode) ?? "length",
    blockStreaming: firstDefined(accountCfg?.blockStreaming, feishuCfg?.blockStreaming) ?? true,
    streaming: firstDefined(accountCfg?.streaming, feishuCfg?.streaming) ?? true,
    mediaMaxMb: firstDefined(accountCfg?.mediaMaxMb, feishuCfg?.mediaMaxMb) ?? 30,
    groups: { ...feishuCfg?.groups, ...accountCfg?.groups },
  };
}

/**
 * Resolve group-specific configuration for a Feishu chat.
 */
export function resolveFeishuGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  chatId: string;
}): { groupConfig?: FeishuGroupConfig } {
  const resolved = resolveFeishuConfig({ cfg: params.cfg, accountId: params.accountId });
  const groupConfig = resolved.groups[params.chatId];
  return { groupConfig };
}

/**
 * Check if a group requires @mention for the bot to respond.
 */
export function resolveFeishuGroupRequireMention(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  chatId: string;
}): boolean {
  const { groupConfig } = resolveFeishuGroupConfig(params);
  // Default: require mention in groups
  return groupConfig?.requireMention ?? true;
}

/**
 * Check if a group is enabled.
 */
export function resolveFeishuGroupEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  chatId: string;
}): boolean {
  const { groupConfig } = resolveFeishuGroupConfig(params);
  return groupConfig?.enabled ?? true;
}
