import type { ChannelMessageActionName } from "../../channels/plugins/types.js";

export type MessageActionTargetMode = "to" | "channelId" | "none";

export const MESSAGE_ACTION_TARGET_MODE: Record<ChannelMessageActionName, MessageActionTargetMode> =
  {
    send: "to",
    broadcast: "none",
    poll: "to",
    react: "to",
    reactions: "to",
    read: "to",
    edit: "to",
    unsend: "to",
    reply: "to",
    sendWithEffect: "to",
    renameGroup: "to",
    setGroupIcon: "to",
    setGroupDescription: "to",
    addParticipant: "to",
    removeParticipant: "to",
    promoteParticipant: "to",
    demoteParticipant: "to",
    leaveGroup: "to",
    getInviteCode: "to",
    revokeInviteCode: "to",
    getGroupInfo: "to",
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
    "voice-status": "none",
    "event-list": "none",
    "event-create": "none",
    timeout: "none",
    kick: "none",
    ban: "none",
    "group-create": "none",
  };

const ACTION_TARGET_ALIASES: Partial<Record<ChannelMessageActionName, string[]>> = {
  unsend: ["messageId"],
  edit: ["messageId"],
  react: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  renameGroup: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  setGroupIcon: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  setGroupDescription: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  addParticipant: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  removeParticipant: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  promoteParticipant: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  demoteParticipant: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  leaveGroup: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  getInviteCode: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  revokeInviteCode: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
  getGroupInfo: ["chatGuid", "chatIdentifier", "chatId", "groupJid"],
};

export function actionRequiresTarget(action: ChannelMessageActionName): boolean {
  return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}

export function actionHasTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
): boolean {
  const to = typeof params.to === "string" ? params.to.trim() : "";
  if (to) {
    return true;
  }
  const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
  if (channelId) {
    return true;
  }
  const aliases = ACTION_TARGET_ALIASES[action];
  if (!aliases) {
    return false;
  }
  return aliases.some((alias) => {
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
