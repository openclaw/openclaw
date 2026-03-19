import type { ChannelMessageActionName } from "../../channels/plugins/types.js";

export type MessageActionTargetMode = "to" | "channelId" | "none";

export const MESSAGE_ACTION_TARGET_MODE: Record<ChannelMessageActionName, MessageActionTargetMode> =
  {
    send: "to",
    broadcast: "none",
    poll: "to",
    "poll-vote": "to",
    react: "to",
    reactions: "to",
    read: "to",
    edit: "to",
    unsend: "to",
    reply: "to",
    sendWithEffect: "to",
    renameGroup: "to",
    setGroupIcon: "to",
    addParticipant: "to",
    removeParticipant: "to",
    leaveGroup: "to",
    sendAttachment: "to",
    delete: "to",
    pin: "to",
    unpin: "to",
    "list-pins": "to",
    permissions: "to",
    "thread-create": "to",
    "thread-list": "none",
    "thread-reply": "to",
    search: "none",
    sticker: "to",
    "sticker-search": "none",
    "member-info": "none",
    "role-info": "none",
    "emoji-list": "none",
    "emoji-upload": "none",
    "sticker-upload": "none",
    "role-add": "none",
    "role-remove": "none",
    "channel-info": "channelId",
    "channel-list": "none",
    "channel-create": "none",
    "channel-edit": "channelId",
    "channel-delete": "channelId",
    "channel-move": "channelId",
    "category-create": "none",
    "category-edit": "none",
    "category-delete": "none",
    "topic-create": "to",
    "topic-edit": "to",
    "voice-status": "none",
    "event-list": "none",
    "event-create": "none",
    timeout: "none",
    kick: "none",
    ban: "none",
    "set-profile": "none",
    "set-presence": "none",
    "set-profile": "none",
    "download-file": "none",
  };

type ActionTargetAliasSpec = {
  aliases: string[];
  channels?: string[];
};

const ACTION_TARGET_ALIASES: Partial<Record<ChannelMessageActionName, ActionTargetAliasSpec>> = {
  read: { aliases: ["messageId"], channels: ["feishu"] },
  unsend: { aliases: ["messageId"] },
  edit: { aliases: ["messageId"] },
  pin: { aliases: ["messageId"], channels: ["feishu"] },
  unpin: { aliases: ["messageId"], channels: ["feishu"] },
  "list-pins": { aliases: ["chatId"], channels: ["feishu"] },
  "channel-info": { aliases: ["chatId"], channels: ["feishu"] },
  react: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  renameGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  setGroupIcon: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  addParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  removeParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  leaveGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
};

export function actionRequiresTarget(action: ChannelMessageActionName): boolean {
  return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}

export function actionHasTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: { channel?: string },
): boolean {
  const to = typeof params.to === "string" ? params.to.trim() : "";
  if (to) {
    return true;
  }
  const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
  if (channelId) {
    return true;
  }
  const spec = ACTION_TARGET_ALIASES[action];
  if (!spec) {
    return false;
  }
  if (
    spec.channels &&
    (!options?.channel || !spec.channels.includes(options.channel.trim().toLowerCase()))
  ) {
    return false;
  }
  return spec.aliases.some((alias) => {
    const value = params[alias];
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return false;
  });
}
