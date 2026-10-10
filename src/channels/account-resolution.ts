import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";

/** Prefer fresh operational preparation without retrying failures through the legacy hook. */
export async function resolveChannelAccount<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ResolvedAccount> {
  const { config } = params.plugin;
  return config.resolveAccountAsync
    ? await config.resolveAccountAsync(params.cfg, params.accountId)
    : config.resolveAccount(params.cfg, params.accountId);
}

export async function channelHasConfiguredState<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean | undefined> {
  const { config } = params.plugin;
  const input = { cfg: params.cfg, env: params.env };
  return config.hasConfiguredStateAsync
    ? await config.hasConfiguredStateAsync(input)
    : config.hasConfiguredState?.(input);
}

/** Async hooks own their result; an empty result or failure never retries a legacy hook. */
export async function resolveChannelAllowFrom<ResolvedAccount>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>, "config">;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const { config } = params.plugin;
  const input = { cfg: params.cfg, accountId: params.accountId };
  return config.resolveAllowFromAsync
    ? await config.resolveAllowFromAsync(input)
    : config.resolveAllowFrom?.(input);
}

export async function describeChannelAccount<ResolvedAccount>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>, "config">;
  account: ResolvedAccount;
  cfg: OpenClawConfig;
}) {
  const { config } = params.plugin;
  return config.describeAccountAsync
    ? await config.describeAccountAsync(params.account, params.cfg)
    : config.describeAccount?.(params.account, params.cfg);
}

export async function resolveChannelDmPolicy<ResolvedAccount>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>, "security">;
  account: ResolvedAccount;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const { security } = params.plugin;
  const input = { cfg: params.cfg, accountId: params.accountId, account: params.account };
  return security?.resolveDmPolicyAsync
    ? await security.resolveDmPolicyAsync(input)
    : security?.resolveDmPolicy?.(input);
}
