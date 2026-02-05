import type { Client } from "@buape/carbon";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { ReplyToMode } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import type {
  DiscordMessageEditHandler,
  DiscordMessageEvent,
  DiscordMessageUpdateEvent,
} from "./listeners.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded-runner/runs.js";
import { clearInboundDedupeKey } from "../../auto-reply/reply/inbound-dedupe.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import { processDiscordMessage } from "./message-handler.process.js";
import { resolveDiscordMessageText } from "./message-utils.js";

type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type DiscordConfig = NonNullable<
  import("../../config/config.js").OpenClawConfig["channels"]
>["discord"];

export function createDiscordMessageEditHandler(params: {
  cfg: LoadedConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: Array<string | number>;
  allowFrom?: Array<string | number>;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordMessageEditHandler {
  const groupPolicy = params.discordConfig?.groupPolicy ?? "open";
  const ackReactionScope = params.cfg.messages?.ackReactionScope ?? "group-mentions";

  return async (data, client) => {
    try {
      await handleDiscordMessageEdit({
        ...params,
        ackReactionScope,
        groupPolicy,
        data,
        client,
      });
    } catch (err) {
      params.runtime.error?.(danger(`discord edit handler failed: ${String(err)}`));
    }
  };
}

async function handleDiscordMessageEdit(params: {
  cfg: LoadedConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: Array<string | number>;
  allowFrom?: Array<string | number>;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  ackReactionScope: "all" | "direct" | "group-all" | "group-mentions";
  groupPolicy: "open" | "disabled" | "allowlist";
  data: DiscordMessageUpdateEvent;
  client: Client;
}) {
  const { data, client, botUserId } = params;
  const message = data.message;

  // Guard: need a valid message with content
  if (!message) {
    return;
  }

  // Guard: ignore edits from the bot itself
  const author = message.author;
  if (!author) {
    return;
  }
  if (botUserId && author.id === botUserId) {
    return;
  }

  // Guard: ignore bot edits (embed unfurls, system updates)
  if (author.bot) {
    return;
  }

  // Guard: must have an edited_timestamp to distinguish real edits from embed unfurls.
  // Carbon's Message wraps the raw data; check the raw field.
  const rawData = (message as { rawData?: Record<string, unknown> }).rawData;
  const editedTimestamp =
    rawData?.edited_timestamp ??
    ("editedTimestamp" in message
      ? (message as { editedTimestamp?: unknown }).editedTimestamp
      : undefined);
  if (!editedTimestamp) {
    return;
  }

  // Guard: ignore if message text is empty after edit
  const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
  if (!baseText.trim()) {
    return;
  }

  if (shouldLogVerbose()) {
    const preview = baseText.length > 80 ? `${baseText.slice(0, 80)}...` : baseText;
    logVerbose(`discord: edit detected for message ${message.id}: "${preview}"`);
  }

  // Resolve session key so we can abort any in-progress run
  const channelId = message.channelId;
  const guildId = data.guild_id ?? data.guild?.id ?? undefined;
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId,
    peer: { kind: "channel", id: channelId },
  });

  // Abort any in-progress processing for this session
  const aborted = abortEmbeddedPiRun(route.sessionKey);
  clearSessionQueues([route.sessionKey]);
  if (aborted && shouldLogVerbose()) {
    logVerbose(`discord: aborted in-progress run for session ${route.sessionKey} (message edit)`);
  }

  // Build a synthetic DiscordMessageEvent from the update data.
  // MessageCreate has `author` at the top level; MessageUpdate does not.
  // We bridge author from message.author and leave member undefined.
  const syntheticData = {
    ...data,
    author,
    member: undefined,
  } as unknown as DiscordMessageEvent;

  // Clear the inbound dedupe entry so the re-processed message isn't rejected as a duplicate.
  // Build a minimal context just for the dedupe key. The actual ctx will be built by preflight.
  clearInboundDedupeKey({
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    MessageSid: message.id,
    To: `discord:channel:${channelId}`,
    From: `discord:${author.id}`,
    SessionKey: route.sessionKey,
    AccountId: params.accountId,
  });

  // Run through the same preflight + process pipeline as new messages
  const ctx = await preflightDiscordMessage({
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: params.accountId,
    token: params.token,
    runtime: params.runtime,
    botUserId: params.botUserId,
    guildHistories: params.guildHistories,
    historyLimit: params.historyLimit,
    mediaMaxBytes: params.mediaMaxBytes,
    textLimit: params.textLimit,
    replyToMode: params.replyToMode,
    dmEnabled: params.dmEnabled,
    groupDmEnabled: params.groupDmEnabled,
    groupDmChannels: params.groupDmChannels,
    allowFrom: params.allowFrom,
    guildEntries: params.guildEntries,
    ackReactionScope: params.ackReactionScope,
    groupPolicy: params.groupPolicy,
    data: syntheticData,
    client,
  });

  if (!ctx) {
    return;
  }

  await processDiscordMessage(ctx);
}
