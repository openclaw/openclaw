import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DiscordActionConfig } from "../../config/config.js";
import {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  fetchChannelPermissionsDiscord,
  fetchReactionsDiscord,
  listPinsDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  searchMessagesDiscord,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  unpinMessageDiscord,
} from "../../discord/send.js";
import { jsonResult, readStringArrayParam, readStringParam } from "./common.js";

type ActionGate = (
  key: keyof DiscordActionConfig,
  defaultValue?: boolean,
) => boolean;

export async function handleDiscordMessagingAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate,
): Promise<AgentToolResult<unknown>> {
  switch (action) {
    case "react": {
      if (!isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { required: true });
      await reactMessageDiscord(channelId, messageId, emoji);
      return jsonResult({ ok: true });
    }
    case "reactions": {
      if (!isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const limitRaw = params.limit;
      const limit =
        typeof limitRaw === "number" && Number.isFinite(limitRaw)
          ? limitRaw
          : undefined;
      const reactions = await fetchReactionsDiscord(channelId, messageId, {
        limit,
      });
      return jsonResult({ ok: true, reactions });
    }
    case "sticker": {
      if (!isActionEnabled("stickers")) {
        throw new Error("Discord stickers are disabled.");
      }
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "content");
      const stickerIds = readStringArrayParam(params, "stickerIds", {
        required: true,
        label: "stickerIds",
      });
      await sendStickerDiscord(to, stickerIds, { content });
      return jsonResult({ ok: true });
    }
    case "poll": {
      if (!isActionEnabled("polls")) {
        throw new Error("Discord polls are disabled.");
      }
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "content");
      const question = readStringParam(params, "question", {
        required: true,
      });
      const answers = readStringArrayParam(params, "answers", {
        required: true,
        label: "answers",
      });
      const allowMultiselectRaw = params.allowMultiselect;
      const allowMultiselect =
        typeof allowMultiselectRaw === "boolean"
          ? allowMultiselectRaw
          : undefined;
      const durationRaw = params.durationHours;
      const durationHours =
        typeof durationRaw === "number" && Number.isFinite(durationRaw)
          ? durationRaw
          : undefined;
      await sendPollDiscord(
        to,
        { question, answers, allowMultiselect, durationHours },
        { content },
      );
      return jsonResult({ ok: true });
    }
    case "permissions": {
      if (!isActionEnabled("permissions")) {
        throw new Error("Discord permissions are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const permissions = await fetchChannelPermissionsDiscord(channelId);
      return jsonResult({ ok: true, permissions });
    }
    case "readMessages": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message reads are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const messages = await readMessagesDiscord(channelId, {
        limit:
          typeof params.limit === "number" && Number.isFinite(params.limit)
            ? params.limit
            : undefined,
        before: readStringParam(params, "before"),
        after: readStringParam(params, "after"),
        around: readStringParam(params, "around"),
      });
      return jsonResult({ ok: true, messages });
    }
    case "sendMessage": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message sends are disabled.");
      }
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "content", {
        required: true,
      });
      const mediaUrl = readStringParam(params, "mediaUrl");
      const replyTo = readStringParam(params, "replyTo");
      const result = await sendMessageDiscord(to, content, {
        mediaUrl,
        replyTo,
      });
      return jsonResult({ ok: true, result });
    }
    case "editMessage": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message edits are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const content = readStringParam(params, "content", {
        required: true,
      });
      const message = await editMessageDiscord(channelId, messageId, {
        content,
      });
      return jsonResult({ ok: true, message });
    }
    case "deleteMessage": {
      if (!isActionEnabled("messages")) {
        throw new Error("Discord message deletes are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await deleteMessageDiscord(channelId, messageId);
      return jsonResult({ ok: true });
    }
    case "threadCreate": {
      if (!isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const name = readStringParam(params, "name", { required: true });
      const messageId = readStringParam(params, "messageId");
      const autoArchiveMinutesRaw = params.autoArchiveMinutes;
      const autoArchiveMinutes =
        typeof autoArchiveMinutesRaw === "number" &&
        Number.isFinite(autoArchiveMinutesRaw)
          ? autoArchiveMinutesRaw
          : undefined;
      const thread = await createThreadDiscord(channelId, {
        name,
        messageId,
        autoArchiveMinutes,
      });
      return jsonResult({ ok: true, thread });
    }
    case "threadList": {
      if (!isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const channelId = readStringParam(params, "channelId");
      const includeArchived =
        typeof params.includeArchived === "boolean"
          ? params.includeArchived
          : undefined;
      const before = readStringParam(params, "before");
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? params.limit
          : undefined;
      const threads = await listThreadsDiscord({
        guildId,
        channelId,
        includeArchived,
        before,
        limit,
      });
      return jsonResult({ ok: true, threads });
    }
    case "threadReply": {
      if (!isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const content = readStringParam(params, "content", {
        required: true,
      });
      const mediaUrl = readStringParam(params, "mediaUrl");
      const replyTo = readStringParam(params, "replyTo");
      const result = await sendMessageDiscord(`channel:${channelId}`, content, {
        mediaUrl,
        replyTo,
      });
      return jsonResult({ ok: true, result });
    }
    case "pinMessage": {
      if (!isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await pinMessageDiscord(channelId, messageId);
      return jsonResult({ ok: true });
    }
    case "unpinMessage": {
      if (!isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await unpinMessageDiscord(channelId, messageId);
      return jsonResult({ ok: true });
    }
    case "listPins": {
      if (!isActionEnabled("pins")) {
        throw new Error("Discord pins are disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const pins = await listPinsDiscord(channelId);
      return jsonResult({ ok: true, pins });
    }
    case "searchMessages": {
      if (!isActionEnabled("search")) {
        throw new Error("Discord search is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const content = readStringParam(params, "content", {
        required: true,
      });
      const channelId = readStringParam(params, "channelId");
      const channelIds = readStringArrayParam(params, "channelIds");
      const authorId = readStringParam(params, "authorId");
      const authorIds = readStringArrayParam(params, "authorIds");
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? params.limit
          : undefined;
      const channelIdList = [
        ...(channelIds ?? []),
        ...(channelId ? [channelId] : []),
      ];
      const authorIdList = [
        ...(authorIds ?? []),
        ...(authorId ? [authorId] : []),
      ];
      const results = await searchMessagesDiscord({
        guildId,
        content,
        channelIds: channelIdList.length ? channelIdList : undefined,
        authorIds: authorIdList.length ? authorIdList : undefined,
        limit,
      });
      return jsonResult({ ok: true, results });
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
