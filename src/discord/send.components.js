import { serializePayload, } from "@buape/carbon";
import { ChannelType, Routes } from "discord-api-types/v10";
import { loadConfig } from "../config/config.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { loadWebMedia } from "../web/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import { registerDiscordComponentEntries } from "./components-registry.js";
import { buildDiscordComponentMessage, buildDiscordComponentMessageFlags, resolveDiscordComponentAttachmentName, } from "./components.js";
import { buildDiscordSendError, createDiscordClient, parseAndResolveRecipient, resolveChannelId, resolveDiscordChannelType, toDiscordFileBlob, stripUndefinedFields, SUPPRESS_NOTIFICATIONS_FLAG, } from "./send.shared.js";
const DISCORD_FORUM_LIKE_TYPES = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);
function extractComponentAttachmentNames(spec) {
    const names = [];
    for (const block of spec.blocks ?? []) {
        if (block.type === "file") {
            names.push(resolveDiscordComponentAttachmentName(block.file));
        }
    }
    return names;
}
export async function sendDiscordComponentMessage(to, spec, opts = {}) {
    const cfg = loadConfig();
    const accountInfo = resolveDiscordAccount({ cfg, accountId: opts.accountId });
    const { token, rest, request } = createDiscordClient(opts, cfg);
    const recipient = await parseAndResolveRecipient(to, opts.accountId);
    const { channelId } = await resolveChannelId(rest, recipient, request);
    const channelType = await resolveDiscordChannelType(rest, channelId);
    if (channelType && DISCORD_FORUM_LIKE_TYPES.has(channelType)) {
        throw new Error("Discord components are not supported in forum-style channels");
    }
    const buildResult = buildDiscordComponentMessage({
        spec,
        sessionKey: opts.sessionKey,
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
        throw new Error("Discord component attachments currently support a single file. Use media-gallery for multiple files.");
    }
    const expectedAttachmentName = uniqueAttachmentNames[0];
    let files;
    if (opts.mediaUrl) {
        const media = await loadWebMedia(opts.mediaUrl, { localRoots: opts.mediaLocalRoots });
        const filenameOverride = opts.filename?.trim();
        const fileName = filenameOverride || media.fileName || "upload";
        if (expectedAttachmentName && expectedAttachmentName !== fileName) {
            throw new Error(`Component file block expects attachment "${expectedAttachmentName}", but the uploaded file is "${fileName}". Update components.blocks[].file or provide a matching filename.`);
        }
        const fileData = toDiscordFileBlob(media.buffer);
        files = [{ data: fileData, name: fileName }];
    }
    else if (expectedAttachmentName) {
        throw new Error("Discord component file blocks require a media attachment (media/path/filePath).");
    }
    const payload = {
        components: buildResult.components,
        ...(finalFlags ? { flags: finalFlags } : {}),
        ...(files ? { files } : {}),
    };
    const body = stripUndefinedFields({
        ...serializePayload(payload),
        ...(messageReference ? { message_reference: messageReference } : {}),
    });
    let result;
    try {
        result = (await request(() => rest.post(Routes.channelMessages(channelId), {
            body,
        }), "components"));
    }
    catch (err) {
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
