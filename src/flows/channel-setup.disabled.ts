import { resolveChannelAccount } from "../channels/account-resolution.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import { resolveChannelConfigRecord } from "../config/channel-configured-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAccountEnabled } from "../shared/account-enabled.js";

export function createChannelSetupDisabledHints(params: {
  getConfig: () => OpenClawConfig;
  getPlugin: (channel: ChannelChoice) => ChannelSetupPlugin | undefined;
  deferStatusUntilSelection: boolean;
}) {
  const resolveConfigDisabledHint = (channel: ChannelChoice): string | undefined => {
    const cfg = params.getConfig();
    if (cfg.plugins?.enabled === false) {
      return "plugins disabled";
    }
    if (cfg.plugins?.entries?.[channel]?.enabled === false) {
      return "plugin disabled";
    }
    return resolveChannelConfigRecord(cfg, channel)?.enabled === false ? "disabled" : undefined;
  };

  const resolveAccountDisabledHint = async (
    channel: ChannelChoice,
    accountId?: string,
  ): Promise<string | undefined> => {
    const plugin = params.getPlugin(channel);
    if (!plugin) {
      return undefined;
    }
    const cfg = params.getConfig();
    const account = await resolveChannelAccount({
      plugin,
      cfg,
      accountId: accountId ?? resolveChannelDefaultAccountId({ plugin, cfg }),
    });
    // Setup steps replace config; retain the current view after account preparation yields.
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, params.getConfig())
      : isAccountEnabled(account);
    return enabled ? undefined : "disabled";
  };

  const resolveDisabledHint = async (channel: ChannelChoice): Promise<string | undefined> => {
    const configDisabledHint = resolveConfigDisabledHint(channel);
    return configDisabledHint || params.deferStatusUntilSelection
      ? configDisabledHint
      : resolveAccountDisabledHint(channel);
  };

  return { resolveConfigDisabledHint, resolveAccountDisabledHint, resolveDisabledHint };
}
