import type { OpenClawConfig } from "../../config/config.js";
import { type ChannelId, getChannelPlugin } from "../../channels/plugins/index.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { requireValidConfigSnapshot } from "../config-validation.js";

export type ChatChannel = ChannelId;

export async function requireValidConfig(
  runtime: RuntimeEnv = defaultRuntime,
): Promise<OpenClawConfig | null> {
  return await requireValidConfigSnapshot(runtime);
}

export function formatAccountLabel(params: { accountId: string; name?: string }) {
  const base = params.accountId || DEFAULT_ACCOUNT_ID;
  if (params.name?.trim()) {
    return `${base} (${params.name.trim()})`;
  }
  return base;
}

export const channelLabel = (channel: ChatChannel) => {
  const plugin = getChannelPlugin(channel);
  return plugin?.meta.label ?? channel;
};

export function formatChannelAccountLabel(params: {
  channel: ChatChannel;
  accountId: string;
  name?: string;
  channelStyle?: (value: string) => string;
  accountStyle?: (value: string) => string;
}): string {
  const channelText = channelLabel(params.channel);
  const accountText = formatAccountLabel({
    accountId: params.accountId,
    name: params.name,
  });
  const styledChannel = params.channelStyle ? params.channelStyle(channelText) : channelText;
  const styledAccount = params.accountStyle ? params.accountStyle(accountText) : accountText;
  return `${styledChannel} ${styledAccount}`;
}

export function shouldUseWizard(params?: { hasFlags?: boolean }) {
  return params?.hasFlags === false;
}
