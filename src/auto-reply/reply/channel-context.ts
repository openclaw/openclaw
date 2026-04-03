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
  ctx: {
    AccountId?: string;
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
  return accountId || "default";
}
