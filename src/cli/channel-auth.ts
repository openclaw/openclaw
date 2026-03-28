import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../channels/plugins/index.js";
import { resolveInstallableChannelPlugin } from "../commands/channel-setup/channel-plugin-resolution.js";
import { loadConfig, writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { setVerbose } from "../globals.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { sanitizeForLog } from "../terminal/ansi.js";

type ChannelAuthOptions = {
  channel?: string;
  account?: string;
  verbose?: boolean;
};

type ChannelPlugin = NonNullable<ReturnType<typeof getChannelPlugin>>;
type ChannelAuthMode = "login" | "logout";

function supportsChannelAuthMode(plugin: ChannelPlugin, mode: ChannelAuthMode): boolean {
  return mode === "login" ? Boolean(plugin.auth?.login) : Boolean(plugin.gateway?.logoutAccount);
}

function isConfiguredAuthPlugin(plugin: ChannelPlugin, cfg: OpenClawConfig): boolean {
  const key = plugin.id;
  if (isBlockedObjectKey(key)) {
    return false;
  }
  const channelCfg = (cfg.channels as Record<string, unknown> | undefined)?.[key];
  if (
    channelCfg &&
    typeof channelCfg === "object" &&
    "enabled" in channelCfg &&
    (channelCfg as { enabled?: unknown }).enabled === false
  ) {
    return false;
  }

  for (const accountId of plugin.config.listAccountIds(cfg)) {
    try {
      const account = plugin.config.resolveAccount(cfg, accountId);
      const enabled = plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : account && typeof account === "object"
          ? ((account as { enabled?: boolean }).enabled ?? true)
          : true;
      if (enabled) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function resolveConfiguredAuthChannelInput(cfg: OpenClawConfig, mode: ChannelAuthMode): string {
  const configured = listChannelPlugins()
    .filter((plugin): plugin is ChannelPlugin => supportsChannelAuthMode(plugin, mode))
    .filter((plugin) => isConfiguredAuthPlugin(plugin, cfg))
    .map((plugin) => plugin.id);

  if (configured.length === 1) {
    return configured[0];
  }
  if (configured.length === 0) {
    throw new Error(`Channel is required (no configured channels support ${mode}).`);
  }
  const safeIds = configured.map(sanitizeForLog);
  throw new Error(
    `Channel is required when multiple configured channels support ${mode}: ${safeIds.join(", ")}`,
  );
}

async function resolveChannelPluginForMode(
  opts: ChannelAuthOptions,
  mode: ChannelAuthMode,
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<{
  cfg: OpenClawConfig;
  configChanged: boolean;
  channelInput: string;
  channelId: string;
  plugin: ChannelPlugin;
}> {
  const explicitChannel = opts.channel?.trim();
  const channelInput = explicitChannel || resolveConfiguredAuthChannelInput(cfg, mode);
  const normalizedChannelId = normalizeChannelId(channelInput);

  const resolved = await resolveInstallableChannelPlugin({
    cfg,
    runtime,
    rawChannel: channelInput,
    ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
    allowInstall: true,
    supports: (candidate) => supportsChannelAuthMode(candidate, mode),
  });
  const channelId = resolved.channelId ?? normalizedChannelId;
  if (!channelId) {
    throw new Error(`Unsupported channel: ${channelInput}`);
  }
  const plugin = resolved.plugin;
  if (!plugin || !supportsChannelAuthMode(plugin, mode)) {
    throw new Error(`Channel ${channelId} does not support ${mode}`);
  }
  return {
    cfg: resolved.cfg,
    configChanged: resolved.configChanged,
    channelInput,
    channelId,
    plugin,
  };
}

function resolveAccountContext(
  plugin: ChannelPlugin,
  opts: ChannelAuthOptions,
  cfg: OpenClawConfig,
) {
  const accountId = opts.account?.trim() || resolveChannelDefaultAccountId({ plugin, cfg });
  return { accountId };
}

export async function runChannelLogin(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const loadedCfg = applyPluginAutoEnable({
    config: loadConfig(),
    env: process.env,
  }).config;
  const { cfg, configChanged, channelInput, plugin } = await resolveChannelPluginForMode(
    opts,
    "login",
    loadedCfg,
    runtime,
  );
  if (configChanged) {
    await writeConfigFile(cfg);
  }
  const login = plugin.auth?.login;
  if (!login) {
    throw new Error(`Channel ${channelInput} does not support login`);
  }
  // Auth-only flow: do not mutate channel config here.
  setVerbose(Boolean(opts.verbose));
  const { accountId } = resolveAccountContext(plugin, opts, cfg);
  await login({
    cfg,
    accountId,
    runtime,
    verbose: Boolean(opts.verbose),
    channelInput,
  });
}

export async function runChannelLogout(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const loadedCfg = applyPluginAutoEnable({
    config: loadConfig(),
    env: process.env,
  }).config;
  const { cfg, configChanged, channelInput, plugin } = await resolveChannelPluginForMode(
    opts,
    "logout",
    loadedCfg,
    runtime,
  );
  if (configChanged) {
    await writeConfigFile(cfg);
  }
  const logoutAccount = plugin.gateway?.logoutAccount;
  if (!logoutAccount) {
    throw new Error(`Channel ${channelInput} does not support logout`);
  }
  // Auth-only flow: resolve account + clear session state only.
  const { accountId } = resolveAccountContext(plugin, opts, cfg);
  const account = plugin.config.resolveAccount(cfg, accountId);
  await logoutAccount({
    cfg,
    accountId,
    account,
    runtime,
  });
}
