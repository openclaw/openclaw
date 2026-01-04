import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ClawdisConfig, SlackActionConfig } from "../../config/config.js";
import {
  deleteSlackMessage,
  editSlackMessage,
  getSlackMemberInfo,
  listSlackEmojis,
  listSlackPins,
  listSlackReactions,
  pinSlackMessage,
  reactSlackMessage,
  readSlackMessages,
  sendSlackMessage,
  unpinSlackMessage,
} from "../../slack/actions.js";
import { jsonResult, readStringParam } from "./common.js";

const messagingActions = new Set([
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "readMessages",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);

type ActionGate = (
  key: keyof SlackActionConfig,
  defaultValue?: boolean,
) => boolean;

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: ClawdisConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled: ActionGate = (key, defaultValue = true) => {
    const value = cfg.slack?.actions?.[key];
    if (value === undefined) return defaultValue;
    return value !== false;
  };

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const channelId = readStringParam(params, "channelId", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const emoji = readStringParam(params, "emoji", { required: true });
      await reactSlackMessage(channelId, messageId, emoji);
      return jsonResult({ ok: true });
    }
    const reactions = await listSlackReactions(channelId, messageId);
    return jsonResult({ ok: true, reactions });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", { required: true });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const result = await sendSlackMessage(to, content, {
          mediaUrl: mediaUrl ?? undefined,
        });
        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const channelId = readStringParam(params, "channelId", {
          required: true,
        });
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          required: true,
        });
        await editSlackMessage(channelId, messageId, content);
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const channelId = readStringParam(params, "channelId", {
          required: true,
        });
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        await deleteSlackMessage(channelId, messageId);
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const channelId = readStringParam(params, "channelId", {
          required: true,
        });
        const limitRaw = params.limit;
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? limitRaw
            : undefined;
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const result = await readSlackMessages(channelId, {
          limit,
          before: before ?? undefined,
          after: after ?? undefined,
        });
        return jsonResult({ ok: true, ...result });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const channelId = readStringParam(params, "channelId", { required: true });
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await pinSlackMessage(channelId, messageId);
      return jsonResult({ ok: true });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await unpinSlackMessage(channelId, messageId);
      return jsonResult({ ok: true });
    }
    const pins = await listSlackPins(channelId);
    return jsonResult({ ok: true, pins });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const info = await getSlackMemberInfo(userId);
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const emojis = await listSlackEmojis();
    return jsonResult({ ok: true, emojis });
  }

  throw new Error(`Unknown action: ${action}`);
}
