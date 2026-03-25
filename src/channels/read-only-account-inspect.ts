import type { OpenClawConfig } from "../config/config.js";
import type { ChannelId } from "./plugins/types.js";

type DiscordInspectModule = typeof import("./read-only-account-inspect.discord.runtime.js");
type SlackInspectModule = typeof import("./read-only-account-inspect.slack.runtime.js");
type TelegramInspectModule = typeof import("./read-only-account-inspect.telegram.runtime.js");

let discordInspectModulePromise: Promise<DiscordInspectModule> | undefined;
let slackInspectModulePromise: Promise<SlackInspectModule> | undefined;
let telegramInspectModulePromise: Promise<TelegramInspectModule> | undefined;

function loadDiscordInspectModule() {
  discordInspectModulePromise ??= import("./read-only-account-inspect.discord.runtime.js");
  return discordInspectModulePromise;
}

function loadSlackInspectModule() {
  slackInspectModulePromise ??= import("./read-only-account-inspect.slack.runtime.js");
  return slackInspectModulePromise;
}

function loadTelegramInspectModule() {
  telegramInspectModulePromise ??= import("./read-only-account-inspect.telegram.runtime.js");
  return telegramInspectModulePromise;
}

export type ReadOnlyInspectedAccount =
  | Awaited<ReturnType<DiscordInspectModule["inspectDiscordAccount"]>>
  | Awaited<ReturnType<SlackInspectModule["inspectSlackAccount"]>>
  | Awaited<ReturnType<TelegramInspectModule["inspectTelegramAccount"]>>;

export async function inspectReadOnlyChannelAccount(params: {
  channelId: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ReadOnlyInspectedAccount | null> {
  if (params.channelId === "discord") {
    const { inspectDiscordAccount } = await loadDiscordInspectModule();
    return inspectDiscordAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  }
  if (params.channelId === "slack") {
    const { inspectSlackAccount } = await loadSlackInspectModule();
    return inspectSlackAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  }
  if (params.channelId === "telegram") {
    const { inspectTelegramAccount } = await loadTelegramInspectModule();
    return inspectTelegramAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });
  }
  return null;
}
