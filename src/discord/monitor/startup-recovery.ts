import type { RequestClient } from "@buape/carbon";
import type { APIChannel, APIMessage } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordAccountConfig } from "../../config/types.discord.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { DiscordMessageHandler, DiscordMessageEvent } from "./listeners.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";

const DEFAULT_RECOVERY_WINDOW_MINUTES = 10;

type StartupRecoveryParams = {
  rest: RequestClient;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
  botUserId?: string;
  runtime: RuntimeEnv;
  messageHandler: DiscordMessageHandler;
  client: unknown;
  allowFrom?: Array<string | number>;
};

/**
 * Check for unanswered DM messages on startup and process them.
 * This handles the case where the bot crashed and missed messages.
 */
export async function runStartupRecovery(params: StartupRecoveryParams): Promise<void> {
  const { rest, discordConfig, runtime, allowFrom } = params;
  const recoveryConfig = discordConfig.startupRecovery;

  if (!recoveryConfig) {
    return;
  }

  const recoveryMinutes =
    typeof recoveryConfig === "number" ? recoveryConfig : DEFAULT_RECOVERY_WINDOW_MINUTES;
  const recoveryWindowMs = recoveryMinutes * 60 * 1000;
  const cutoffTime = Date.now() - recoveryWindowMs;

  runtime.log?.(`discord: checking for unanswered messages from last ${recoveryMinutes} minutes`);

  try {
    // Resolve DM channels by opening them with each allowlisted user.
    // GET /users/@me/channels returns only cached channels, which is empty
    // after a restart — exactly when recovery matters. POST is idempotent
    // and returns the existing DM channel for each user.
    let relevantChannels: APIChannel[] = [];

    if (allowFrom && allowFrom.length > 0) {
      for (const userId of allowFrom) {
        try {
          const channel = (await rest.post(Routes.userChannels(), {
            body: { recipient_id: String(userId) },
          })) as APIChannel;
          if (channel?.id) {
            relevantChannels.push(channel);
          }
        } catch (err) {
          runtime.log?.(
            `discord startup-recovery: failed to open DM for user ${userId}: ${formatErrorMessage(err)}`,
          );
        }
      }
    } else {
      // No allowlist — fall back to cached channel list (may be empty after restart)
      const dmChannels = (await rest.get(Routes.userChannels())) as APIChannel[];
      if (dmChannels?.length) {
        const groupDmEnabled = discordConfig.dm?.groupEnabled ?? false;
        relevantChannels = dmChannels.filter((channel) => {
          const isDm = channel.type === ChannelType.DM;
          const isGroupDm = channel.type === ChannelType.GroupDM;
          return isDm || (isGroupDm && groupDmEnabled);
        });
      }
    }

    if (relevantChannels.length === 0) {
      runtime.log?.("discord startup-recovery: no DM channels found");
      return;
    }

    logVerbose(`discord startup-recovery: found ${relevantChannels.length} DM channel(s) to check`);

    let processedCount = 0;

    for (const channel of relevantChannels) {
      try {
        const processed = await checkAndProcessChannel({
          ...params,
          channelId: channel.id,
          channel,
          cutoffTime,
        });
        if (processed) {
          processedCount++;
        }
      } catch (err) {
        runtime.log?.(
          `discord startup-recovery: failed to check channel ${channel.id}: ${formatErrorMessage(err)}`,
        );
      }
    }

    if (processedCount > 0) {
      runtime.log?.(`discord: recovered and processed ${processedCount} unanswered message(s)`);
    } else {
      runtime.log?.("discord startup-recovery: no unanswered messages found");
    }
  } catch (err) {
    runtime.log?.(
      `discord startup-recovery: failed to fetch DM channels: ${formatErrorMessage(err)}`,
    );
  }
}

async function checkAndProcessChannel(
  params: StartupRecoveryParams & {
    channelId: string;
    channel: APIChannel;
    cutoffTime: number;
  },
): Promise<boolean> {
  const { rest, channelId, botUserId, cutoffTime, messageHandler, client } = params;

  // Fetch recent messages (limit to 10 to avoid processing too much history)
  const messages = (await rest.get(Routes.channelMessages(channelId), {
    limit: 10,
  })) as APIMessage[];

  if (!messages || messages.length === 0) {
    return false;
  }

  // Messages are returned newest first
  // Find the most recent user message that hasn't been responded to
  let lastUserMessage: APIMessage | null = null;
  let botRespondedAfter = false;

  for (const msg of messages) {
    const isFromBot = msg.author?.id === botUserId || msg.author?.bot;
    const msgTime = new Date(msg.timestamp).getTime();

    // Skip messages older than cutoff
    if (msgTime < cutoffTime) {
      break;
    }

    if (isFromBot) {
      // Lifecycle DMs (shutdown/online notifications) aren't real responses;
      // skip them so we don't wrongly mark a user message as answered.
      if (isLifecycleMessage(msg.content)) {
        continue;
      }
      // Bot has responded, so any earlier user messages are answered
      botRespondedAfter = true;
      break;
    }

    if (!lastUserMessage) {
      lastUserMessage = msg;
    }
  }

  if (!lastUserMessage || botRespondedAfter) {
    return false;
  }

  // Found an unanswered message - process it
  logVerbose(
    `discord startup-recovery: processing unanswered message ${lastUserMessage.id} from ${lastUserMessage.author?.username ?? "unknown"}`,
  );

  // Construct a message event that matches what the listener expects
  const event: DiscordMessageEvent = {
    message: lastUserMessage as DiscordMessageEvent["message"],
    author: lastUserMessage.author as DiscordMessageEvent["author"],
    guild: undefined,
    member: undefined,
  };

  // Process through the normal handler
  await messageHandler(event, client as Parameters<DiscordMessageHandler>[1]);

  return true;
}

const LIFECYCLE_MESSAGES = new Set(["*Back online.*", "*Shutting down...*"]);

function isLifecycleMessage(content: string | undefined): boolean {
  return !!content && LIFECYCLE_MESSAGES.has(content.trim());
}
