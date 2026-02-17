import type { ChannelId, ChannelSetupInput } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAccountId } from "../../routing/session-key.js";

type ChatChannel = ChannelId;

export function applyAccountName(params: {
  cfg: OpenClawConfig;
  channel: ChatChannel;
  accountId: string;
  name?: string;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const plugin = getChannelPlugin(params.channel);
  const apply = plugin?.setup?.applyAccountName;
  return apply ? apply({ cfg: params.cfg, accountId, name: params.name }) : params.cfg;
}

export function applyChannelAccountConfig(params: {
  cfg: OpenClawConfig;
  channel: ChatChannel;
  accountId: string;
  input: ChannelSetupInput;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const plugin = getChannelPlugin(params.channel);
  const apply = plugin?.setup?.applyAccountConfig;
  if (!apply) {
    return params.cfg;
  }
  return apply({ cfg: params.cfg, accountId, input: params.input });
}
