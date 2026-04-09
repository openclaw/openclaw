import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";

type CommandSurfaceParams = {
  ctx: {
    OriginatingChannel?: string;
    Surface?: string;
    Provider?: string;
    AccountId?: string;
  };
  command: {
    channel?: string;
  };
};

type ChannelAccountParams = {
  cfg: OpenClawConfig;
  ctx: {
    OriginatingChannel?: string;
    Surface?: string;
    Provider?: string;
    AccountId?: string;
  };
  command: {
    channel?: string;
  };
};

export function resolveCommandSurfaceChannel(params: CommandSurfaceParams): string {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return String(channel ?? "")
    .trim()
    .toLowerCase();
}

export function resolveChannelAccountId(params: ChannelAccountParams): string {
  const accountId = typeof params.ctx.AccountId === "string" ? params.ctx.AccountId.trim() : "";
  if (accountId) {
    return accountId;
  }
  const channel = resolveCommandSurfaceChannel(params);
  const plugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  const configuredDefault = plugin?.config.defaultAccountId?.(params.cfg)?.trim();
  return configuredDefault || "default";
}
