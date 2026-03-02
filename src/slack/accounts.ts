import { normalizeChatType } from "../channels/chat-type.js";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SlackAccountConfig } from "../config/types.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";

export type SlackTokenSource = "env" | "config" | "none";

export type ResolvedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  appToken?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
  groupPolicy?: SlackAccountConfig["groupPolicy"];
  textChunkLimit?: SlackAccountConfig["textChunkLimit"];
  mediaMaxMb?: SlackAccountConfig["mediaMaxMb"];
  reactionNotifications?: SlackAccountConfig["reactionNotifications"];
  reactionAllowlist?: SlackAccountConfig["reactionAllowlist"];
  replyToMode?: SlackAccountConfig["replyToMode"];
  replyToModeByChatType?: SlackAccountConfig["replyToModeByChatType"];
  actions?: SlackAccountConfig["actions"];
  slashCommand?: SlackAccountConfig["slashCommand"];
  dm?: SlackAccountConfig["dm"];
  channels?: SlackAccountConfig["channels"];
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("slack");
export const listSlackAccountIds = listAccountIds;
export const resolveDefaultSlackAccountId = resolveDefaultAccountId;

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.slack?.accounts, accountId);
}

function mergeSlackAccountConfig(cfg: OpenClawConfig, accountId: string): SlackAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.slack ?? {}) as SlackAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSlackAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envBot = allowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : undefined;
  const envApp = allowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : undefined;
  const envUser = allowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : undefined;
  const configBot = resolveSlackBotToken(merged.botToken);
  const configApp = resolveSlackAppToken(merged.appToken);
  const configUser = resolveSlackUserToken(merged.userToken);
  const botToken = configBot ?? envBot;
  const appToken = configApp ?? envApp;
  const userToken = configUser ?? envUser;
  const botTokenSource: SlackTokenSource = configBot ? "config" : envBot ? "env" : "none";
  const appTokenSource: SlackTokenSource = configApp ? "config" : envApp ? "env" : "none";
  const userTokenSource: SlackTokenSource = configUser ? "config" : envUser ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    botToken,
    appToken,
    userToken,
    botTokenSource,
    appTokenSource,
    userTokenSource,
    config: merged,
    groupPolicy: merged.groupPolicy,
    textChunkLimit: merged.textChunkLimit,
    mediaMaxMb: merged.mediaMaxMb,
    reactionNotifications: merged.reactionNotifications,
    reactionAllowlist: merged.reactionAllowlist,
    replyToMode: merged.replyToMode,
    replyToModeByChatType: merged.replyToModeByChatType,
    actions: merged.actions,
    slashCommand: merged.slashCommand,
    dm: merged.dm,
    channels: merged.channels,
  };
}

export function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[] {
  return listSlackAccountIds(cfg)
    .map((accountId) => resolveSlackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveSlackReplyToMode(
  account: ResolvedSlackAccount,
  chatType?: string | null,
): "off" | "first" | "all" {
  const normalized = normalizeChatType(chatType ?? undefined);
  if (normalized && account.replyToModeByChatType?.[normalized] !== undefined) {
    return account.replyToModeByChatType[normalized] ?? "off";
  }
  if (normalized === "direct" && account.dm?.replyToMode !== undefined) {
    return account.dm.replyToMode;
  }
  return account.replyToMode ?? "off";
}
