import {
  serializePayload,
  type MessagePayloadFile,
  type MessagePayloadObject,
  type RequestClient,
} from "@buape/carbon";
import type { APIChannel } from "discord-api-types/v10";
import { ChannelType, Routes } from "discord-api-types/v10";
import { loadConfig } from "../config/config.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { buildAgentSessionKey } from "../routing/resolve-route.js";
import { loadWebMedia } from "../web/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import { registerDiscordComponentEntries } from "./components-registry.js";
import {
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  resolveDiscordComponentAttachmentName,
  type DiscordComponentMessageSpec,
} from "./components.js";
import {
  buildDiscordSendError,
  createDiscordClient,
  parseAndResolveRecipient,
  resolveChannelId,
  stripUndefinedFields,
  SUPPRESS_NOTIFICATIONS_FLAG,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";

const DISCORD_FORUM_LIKE_TYPES = new Set<number>([ChannelType.GuildForum, ChannelType.GuildMedia]);

type DiscordRecipient = Awaited<ReturnType<typeof parseAndResolveRecipient>>;

function resolveDiscordDmRecipientId(channel?: APIChannel): string | undefined {
  if (!channel || channel.type !== ChannelType.DM) {
    return undefined;
  }
  const recipients = (channel as { recipients?: Array<{ id?: string }> }).recipients;
  const recipientId = recipients?.[0]?.id;
  if (typeof recipientId !== "string") {
    return undefined;
  }
  const trimmed = recipientId.trim();
  return trimmed ? trimmed : undefined;
}

function resolveDiscordComponentSessionKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId: string;
  agentId?: string;
  sessionKey?: string;
  recipient: DiscordRecipient;
  channel?: APIChannel;
}): string | undefined {
  if (!params.sessionKey || !params.agentId) {
    return params.sessionKey;
  }
  if (params.recipient.kind !== "channel") {
    return params.sessionKey;
  }
  const recipientId = resolveDiscordDmRecipientId(params.channel);
  if (!recipientId) {
    return params.sessionKey;
  }
  // DM channel IDs should map back to the user session for component interactions.
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "discord",
    accountId: params.accountId,
    peer: { kind: "direct", id: recipientId },
    dmScope: params.cfg.session?.dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
}

function extractComponentAttachmentNames(spec: DiscordComponentMessageSpec): string[] {
  const names: string[] = [];
  for (const block of spec.blocks ?? []) {
    if (block.type === "file") {
      names.push(resolveDiscordComponentAttachmentName(block.file));
    }
  }
  return names;
}

type DiscordComponentSendOpts = {
  accountId?: string;
  token?: string;
  rest?: RequestClient;
  silent?: boolean;
  replyTo?: string;
  sessionKey?: string;
  agentId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  filename?: string;
};

export async function sendDiscordComponentMessage(
  to: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const accountInfo = resolveDiscordAccount({ cfg, accountId: opts.accountId });
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  let channel: APIChannel | undefined;
  let channelType: number | undefined;
  try {
    channel = (await rest.get(Routes.channel(channelId))) as APIChannel | undefined;
    channelType = channel?.type;
  } catch {
    channelType = undefined;
  }

  if (channelType && DISCORD_FORUM_LIKE_TYPES.has(channelType)) {
    throw new Error("Discord components are not supported in forum-style channels");
  }

  const componentSessionKey = resolveDiscordComponentSessionKey({
    cfg,
    accountId: accountInfo.accountId,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    recipient,
    channel,
  });

  const buildResult = buildDiscordComponentMessage({
    spec,
    sessionKey: componentSessionKey,
    agentId: opts.agentId,
    accountId: accountInfo.accountId,
  });
  const flags = buildDiscordComponentMessageFlags(buildResult.components);
  const finalFlags = opts.silent
    ? (flags ?? 0) | SUPPRESS_NOTIFICATIONS_FLAG
    : (flags ?? undefined);
  const messageReference = opts.replyTo
    ? { message_id: opts.replyTo, fail_if_not_exists: false }
    : undefined;

  const attachmentNames = extractComponentAttachmentNames(spec);
  const uniqueAttachmentNames = [...new Set(attachmentNames)];
  if (uniqueAttachmentNames.length > 1) {
    throw new Error(
      "Discord component attachments currently support a single file. Use media-gallery for multiple files.",
    );
  }
  const expectedAttachmentName = uniqueAttachmentNames[0];
  let files: MessagePayloadFile[] | undefined;
  if (opts.mediaUrl) {
    const media = await loadWebMedia(opts.mediaUrl, { localRoots: opts.mediaLocalRoots });
    const filenameOverride = opts.filename?.trim();
    const fileName = filenameOverride || media.fileName || "upload";
    if (expectedAttachmentName && expectedAttachmentName !== fileName) {
      throw new Error(
        `Component file block expects attachment "${expectedAttachmentName}", but the uploaded file is "${fileName}". Update components.blocks[].file or provide a matching filename.`,
      );
    }
    let fileData: Blob;
    if (media.buffer instanceof Blob) {
      fileData = media.buffer;
    } else {
      const arrayBuffer = new ArrayBuffer(media.buffer.byteLength);
      new Uint8Array(arrayBuffer).set(media.buffer);
      fileData = new Blob([arrayBuffer]);
    }
    files = [{ data: fileData, name: fileName }];
  } else if (expectedAttachmentName) {
    throw new Error(
      "Discord component file blocks require a media attachment (media/path/filePath).",
    );
  }

  const payload: MessagePayloadObject = {
    components: buildResult.components,
    ...(finalFlags ? { flags: finalFlags } : {}),
    ...(files ? { files } : {}),
  };
  const body = stripUndefinedFields({
    ...serializePayload(payload),
    ...(messageReference ? { message_reference: messageReference } : {}),
  });

  let result: { id: string; channel_id: string };
  try {
    result = (await request(
      () =>
        rest.post(Routes.channelMessages(channelId), {
          body,
        }) as Promise<{ id: string; channel_id: string }>,
      "components",
    )) as { id: string; channel_id: string };
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      rest,
      token,
      hasMedia: Boolean(files?.length),
    });
  }

  registerDiscordComponentEntries({
    entries: buildResult.entries,
    modals: buildResult.modals,
    messageId: result.id,
  });

  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.id ?? "unknown",
    channelId: result.channel_id ?? channelId,
  };
}
