/**
 * Minimal Feishu types for core send/accounts/probe.
 * Full config schema (zod-based) lives in extensions/feishu.
 */
export type FeishuDomain = "feishu" | "lark" | (string & Record<never, never>);

export type FeishuAccountConfig = {
  appId?: string;
  appSecret?: string;
  enabled?: boolean;
  name?: string;
  domain?: FeishuDomain;
  encryptKey?: string;
  verificationToken?: string;
};

export type FeishuConfig = {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  encryptKey?: string;
  verificationToken?: string;
  accounts?: Record<string, FeishuAccountConfig>;
};

export type ResolvedFeishuAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
  config: FeishuConfig;
};

export type FeishuIdType = "open_id" | "user_id" | "union_id" | "chat_id";

export type FeishuSendResult = {
  messageId: string;
  chatId: string;
};

export type MentionTarget = {
  openId: string;
  name: string;
  key: string;
};

export type FeishuProbeResult = {
  ok: boolean;
  appId?: string;
  botName?: string;
  botOpenId?: string;
  error?: string;
};
