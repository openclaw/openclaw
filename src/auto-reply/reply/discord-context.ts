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
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return (
    String(channel ?? "")
      .trim()
      .toLowerCase() === "discord"
  );
}

export function resolveDiscordAccountId(params: DiscordAccountParams): string {
  const accountId = typeof params.ctx.AccountId === "string" ? params.ctx.AccountId.trim() : "";
  return accountId || "default";
}
