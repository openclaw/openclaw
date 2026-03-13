import type { OpenClawConfig } from "../config/config.js";
import type { ChannelId } from "./plugins/types.js";
import { inspectDiscordAccount, type InspectedDiscordAccount } from "../discord/account-inspect.js";
import { inspectSlackAccount, type InspectedSlackAccount } from "../slack/account-inspect.js";
import {
  inspectTelegramAccount,
  type InspectedTelegramAccount,
} from "../telegram/account-inspect.js";

export type ReadOnlyInspectedAccount =
  | InspectedDiscordAccount
  | InspectedSlackAccount
  | InspectedTelegramAccount;

export function inspectReadOnlyChannelAccount(params: {
  channelId: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ReadOnlyInspectedAccount | null {
  if (params.channelId === "discord") {
    return inspectDiscordAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  }
  if (params.channelId === "slack") {
    return inspectSlackAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  }
  if (params.channelId === "telegram") {
    return inspectTelegramAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  }
  return null;
}
