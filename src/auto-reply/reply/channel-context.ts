type DiscordSurfaceParams = {
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

type DiscordAccountParams = {
  ctx: {
    AccountId?: string;
  };
};

export function isDiscordSurface(params: DiscordSurfaceParams): boolean {
  return resolveCommandSurfaceChannel(params) === "discord";
}

export function isTelegramSurface(params: DiscordSurfaceParams): boolean {
  return resolveCommandSurfaceChannel(params) === "telegram";
}

export function isMatrixSurface(params: DiscordSurfaceParams): boolean {
  return resolveCommandSurfaceChannel(params) === "matrix";
}

export function resolveCommandSurfaceChannel(params: DiscordSurfaceParams): string {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return String(channel ?? "")
    .trim()
    .toLowerCase();
}

export function resolveDiscordAccountId(params: DiscordAccountParams): string {
  return resolveChannelAccountId(params);
}

export function resolveChannelAccountId(params: DiscordAccountParams): string {
  const accountId = typeof params.ctx.AccountId === "string" ? params.ctx.AccountId.trim() : "";
  return accountId || "default";
}
