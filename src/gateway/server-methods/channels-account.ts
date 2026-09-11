// Account selection and runtime lookup shared by channel lifecycle and status RPCs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";

export function resolveRuntimeAccountSnapshot(params: {
  runtime: ChannelRuntimeSnapshot;
  channelId: ChannelId;
  accountId: string;
}): ChannelAccountSnapshot | undefined {
  const accounts = params.runtime.channelAccounts[params.channelId];
  const direct = accounts?.[params.accountId];
  if (direct) {
    return direct;
  }
  const fallback = params.runtime.channels[params.channelId];
  return fallback?.accountId === params.accountId ? fallback : undefined;
}

export function resolveChannelGatewayAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  // Runtime operations use the same account precedence as channel setup:
  // explicit request, plugin default, first configured account, then fallback.
  return (
    normalizeOptionalString(params.accountId) ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID
  );
}
