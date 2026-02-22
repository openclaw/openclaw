import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { DEFAULT_CHAT_CHANNEL } from "../channels/registry.js";
import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type ChannelAuthOptions = {
  channel?: string;
  account?: string;
  verbose?: boolean;
};

type ChannelPlugin = NonNullable<ReturnType<typeof getChannelPlugin>>;
type ChannelAuthMode = "login" | "logout";

function resolveChannelPluginForMode(
  opts: ChannelAuthOptions,
  mode: ChannelAuthMode,
): { channelInput: string; channelId: string; plugin: ChannelPlugin } {
  const channelInput = opts.channel ?? DEFAULT_CHAT_CHANNEL;
  const channelId = normalizeChannelId(channelInput);
  if (!channelId) {
    throw new Error(`Unsupported channel: ${channelInput}`);
  }
  const plugin = getChannelPlugin(channelId);
  const supportsMode =
    mode === "login" ? Boolean(plugin?.auth?.login) : Boolean(plugin?.gateway?.logoutAccount);
  if (!supportsMode) {
    throw new Error(`Channel ${channelId} does not support ${mode}`);
  }
  return { channelInput, channelId, plugin: plugin as ChannelPlugin };
}

function resolveAccountContext(plugin: ChannelPlugin, opts: ChannelAuthOptions) {
  const cfg = loadConfig();
  const accountId = opts.account?.trim() || resolveChannelDefaultAccountId({ plugin, cfg });
  return { cfg, accountId };
}

export async function runChannelLogin(
  opts: ChannelAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const { channelInput, plugin } = resolveChannelPluginForMode(opts, "login");
  const login = plugin.auth?.login;
  if (!login) {
    throw new Error(`Channel ${channelInput} does not support login`);
  }
  // Auth-only flow: do not mutate channel config here.
  setVerbose(Boolean(opts.verbose));
  const { cfg, accountId } = resolveAccountContext(plugin, opts);
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
  const { channelInput, plugin } = resolveChannelPluginForMode(opts, "logout");
  const logoutAccount = plugin.gateway?.logoutAccount;
  if (!logoutAccount) {
    throw new Error(`Channel ${channelInput} does not support logout`);
  }
  // Auth-only flow: resolve account + clear session state only.
  const { cfg, accountId } = resolveAccountContext(plugin, opts);
  const account = plugin.config.resolveAccount(cfg, accountId);
  await logoutAccount({
    cfg,
    accountId,
    account,
    runtime,
  });
}
