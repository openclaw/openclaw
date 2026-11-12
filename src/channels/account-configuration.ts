import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import type { AnyChannelPlugin as ChannelPlugin } from "./plugins/types.plugin.js";

export function resolveChannelAccountEnabled(params: {
  plugin: ChannelPlugin;
  account: unknown;
  cfg: OpenClawConfig;
}): boolean {
  if (params.plugin.config.isEnabled) {
    return params.plugin.config.isEnabled(params.account, params.cfg);
  }
  const enabled = isRecord(params.account) ? params.account.enabled : undefined;
  return enabled !== false;
}

/** Preserve the account owner's released default unless it declares configured=false. */
export function readChannelAccountConfigured(params: {
  plugin: ChannelPlugin;
  account: unknown;
  cfg: OpenClawConfig;
}): boolean | Promise<boolean> {
  return (
    params.plugin.config.isConfigured?.(params.account, params.cfg) ??
    (isRecord(params.account) ? params.account.configured !== false : true)
  );
}
