import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { resolveInstallableChannelPlugin } from "../commands/channel-setup/channel-plugin-resolution.js";
import { loadConfig, writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type ChannelAuthOptions = {
  channel?: string;
  account?: string;
  verbose?: boolean;
};

type ChannelPlugin = NonNullable<ReturnType<typeof getChannelPlugin>>;
type ChannelAuthMode = "login" | "logout";

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
  const channelInput = explicitChannel
    ? explicitChannel
    : (await resolveMessageChannelSelection({ cfg })).channel;
  const channelId = normalizeChannelId(channelInput);
  if (!channelId) {
    throw new Error(`Unsupported channel: ${channelInput}`);
  }

  const resolved = await resolveInstallableChannelPlugin({
    cfg,
    runtime,
    channelId,
    allowInstall: true,
    supports: (candidate) =>
      mode === "login" ? Boolean(candidate.auth?.login) : Boolean(candidate.gateway?.logoutAccount),
  });
  const plugin = resolved.plugin;
  const supportsMode =
    mode === "login" ? Boolean(plugin?.auth?.login) : Boolean(plugin?.gateway?.logoutAccount);
  if (!supportsMode) {
    throw new Error(`Channel ${channelId} does not support ${mode}`);
  }
  return {
    cfg: resolved.cfg,
    configChanged: resolved.configChanged,
    channelInput,
    channelId,
    plugin: plugin as ChannelPlugin,
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
  const loadedCfg = loadConfig();
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
  const loadedCfg = loadConfig();
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
