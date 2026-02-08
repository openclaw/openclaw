import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";
import { createActionGate, readStringParam } from "../../../agents/tools/common.js";
import { handleKookAction } from "../../../agents/tools/kook-actions.js";
import { listEnabledKookAccounts } from "../../../kook/accounts.js";

const providerId = "kook";

// ============================================
// Action 名称映射: kebab-case → camelCase
// ============================================
const KOOK_ACTION_NAME_MAP: Record<string, string> = {
  // User Actions
  "get-me": "getMe",
  "get-user": "getUser",
  // Guild Actions
  "guild-list": "getGuildList",
  "guild-info": "getGuild",
  "guild-user-count": "getGuildUserCount",
  "guild-users": "getGuildUsers",
  // Channel Actions
  "channel-info": "getChannel",
  "channel-list": "getChannelList",
  "channel-user-list": "getChannelUserList",
  // Role Management
  "role-info": "roleInfo",
  "role-create": "roleCreate",
  "role-update": "roleUpdate",
  "role-delete": "roleDelete",
  "role-grant": "roleGrant",
  "role-revoke": "roleRevoke",
  // Channel Management
  "channel-create": "createChannel",
  "channel-update": "updateChannel",
  "channel-delete": "deleteChannel",
  "move-user": "moveUser",
  // Member & Moderation
  "update-nickname": "updateNickname",
  "kick-user": "kickUser",
  "leave-guild": "leaveGuild",
  // Emoji Management
  "emoji-list": "emojiList",
  "emoji-create": "emojiCreate",
  "emoji-update": "emojiUpdate",
  "emoji-delete": "emojiDelete",
  // Mute Management
  "mute-list": "muteList",
  "mute-create": "muteCreate",
  "mute-delete": "muteDelete",
};

export const kookMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledKookAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const gate = createActionGate(cfg.channels?.kook?.actions);
    const actions = new Set<ChannelMessageActionName>();

    // Message send (default: enabled)
    if (gate("messages", true)) {
      actions.add("send");
      actions.add("read");
      actions.add("edit");
      actions.add("delete");
    }
    if (gate("reactions", true)) {
      actions.add("react");
      actions.add("reactions");
    }

    // User Actions (read-only, default: enabled) - kebab-case for message tool compatibility
    if (gate("getMe", true)) {
      actions.add("get-me" as ChannelMessageActionName);
    }
    if (gate("getUser", true)) {
      actions.add("get-user" as ChannelMessageActionName);
    }

    // Guild Actions (read-only, default: enabled) - kebab-case
    if (gate("getGuildList", true) && gate("guildInfo", true)) {
      actions.add("guild-list" as ChannelMessageActionName);
    }
    if (gate("getGuild", true) && gate("guildInfo", true)) {
      actions.add("guild-info" as ChannelMessageActionName);
    }
    if (gate("getGuildUserCount", true) && gate("guildInfo", true)) {
      actions.add("guild-user-count" as ChannelMessageActionName);
    }
    if (gate("getGuildUsers", true) && gate("guildInfo", true)) {
      actions.add("guild-users" as ChannelMessageActionName);
    }

    // Channel Actions (read-only, default: enabled) - kebab-case
    if (gate("getChannel", true) && gate("channelInfo", true)) {
      actions.add("channel-info" as ChannelMessageActionName);
    }
    if (gate("getChannelList", true) && gate("channelInfo", true)) {
      actions.add("channel-list" as ChannelMessageActionName);
    }
    if (gate("getChannelUserList", true) && gate("channelInfo", true)) {
      actions.add("channel-user-list" as ChannelMessageActionName);
    }

    // Role Management (roleInfo: read-only default enabled, roles: write default enabled) - kebab-case
    if (gate("roleInfo", true)) {
      actions.add("role-info" as ChannelMessageActionName);
    }
    if (gate("roles", true)) {
      actions.add("role-create" as ChannelMessageActionName);
      actions.add("role-update" as ChannelMessageActionName);
      actions.add("role-delete" as ChannelMessageActionName);
      actions.add("role-grant" as ChannelMessageActionName);
      actions.add("role-revoke" as ChannelMessageActionName);
    }

    // Channel Management (write operations, default: disabled) - kebab-case
    if (gate("channels", false)) {
      actions.add("channel-create" as ChannelMessageActionName);
      actions.add("channel-update" as ChannelMessageActionName);
      actions.add("channel-delete" as ChannelMessageActionName);
      actions.add("move-user" as ChannelMessageActionName);
    }

    // Member & Moderation (write operations, default: disabled) - kebab-case
    if (gate("memberInfo", false)) {
      actions.add("update-nickname" as ChannelMessageActionName);
    }
    if (gate("moderation", false)) {
      actions.add("kick-user" as ChannelMessageActionName);
      actions.add("mute-list" as ChannelMessageActionName);
      actions.add("mute-create" as ChannelMessageActionName);
      actions.add("mute-delete" as ChannelMessageActionName);
    }
    if (gate("guildInfo", false)) {
      actions.add("leave-guild" as ChannelMessageActionName);
    }

    // Emoji Management (emojiList: read-only default enabled, emojiUploads: write default disabled) - kebab-case
    if (gate("emojiList", true)) {
      actions.add("emoji-list" as ChannelMessageActionName);
    }
    if (gate("emojiUploads", false)) {
      actions.add("emoji-create" as ChannelMessageActionName);
      actions.add("emoji-update" as ChannelMessageActionName);
      actions.add("emoji-delete" as ChannelMessageActionName);
    }

    return Array.from(actions);
  },
  supportsButtons: () => false,
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action === "sendMessage") {
      const to = typeof args.to === "string" ? args.to : undefined;
      const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
      return to ? { to, accountId } : null;
    }
    return null;
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    const resolveChannelId = () => {
      const value = readStringParam(params, "channelId") ?? readStringParam(params, "to");
      if (!value) {
        throw new Error("channelId or to is required.");
      }
      return value.startsWith("channel:") ? value.slice("channel:".length) : value;
    };

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const message = readStringParam(params, "message", { required: true, allowEmpty: true });
      return await handleKookAction(
        { action: "sendMessage", to, content: message, accountId: accountId ?? undefined },
        cfg,
      );
    }
    if (action === "read") {
      const limitRaw = params.limit;
      const limit =
        typeof limitRaw === "number"
          ? limitRaw
          : typeof limitRaw === "string" && limitRaw.trim()
            ? Number(limitRaw)
            : undefined;
      return await handleKookAction(
        {
          action: "readMessages",
          channelId: resolveChannelId(),
          limit: Number.isFinite(limit) ? limit : undefined,
          msgId: readStringParam(params, "msgId") ?? readStringParam(params, "before"),
          flag:
            readStringParam(params, "flag") ??
            (readStringParam(params, "before")
              ? "before"
              : readStringParam(params, "after")
                ? "after"
                : undefined),
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }
    if (action === "edit") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const content = readStringParam(params, "message", { required: true, allowEmpty: true });
      return await handleKookAction(
        {
          action: "editMessage",
          channelId: resolveChannelId(),
          messageId,
          content,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }
    if (action === "delete" || action === "unsend") {
      const messageId = readStringParam(params, "messageId", { required: true });
      return await handleKookAction(
        {
          action: "deleteMessage",
          channelId: resolveChannelId(),
          messageId,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }
    if (action === "react") {
      const remove = typeof params.remove === "boolean" ? params.remove : false;
      const messageId = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { required: true });
      return await handleKookAction(
        {
          action: remove ? "removeReaction" : "react",
          channelId: resolveChannelId(),
          messageId,
          emoji,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }
    if (action === "reactions") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { required: true });
      return await handleKookAction(
        {
          action: "reactions",
          channelId: resolveChannelId(),
          messageId,
          emoji,
          limit: readStringParam(params, "limit") ?? undefined,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    // ============================================
    // 关键：kebab-case → camelCase 转换
    // ============================================
    const mappedAction = KOOK_ACTION_NAME_MAP[action] || action;

    // User Actions
    if (mappedAction === "getMe") {
      return await handleKookAction({ action: "getMe", accountId: accountId ?? undefined }, cfg);
    }

    if (mappedAction === "getUser") {
      const userId = readStringParam(params, "userId", { required: true });
      const guildId = readStringParam(params, "guildId");
      return await handleKookAction(
        { action: "getUser", userId, guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    // Guild Actions
    if (mappedAction === "getGuildList") {
      return await handleKookAction(
        { action: "getGuildList", accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "getGuild") {
      const guildId = readStringParam(params, "guildId", { required: true });
      return await handleKookAction(
        { action: "getGuild", guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "getGuildUserCount") {
      const guildId = readStringParam(params, "guildId", { required: true });
      return await handleKookAction(
        { action: "getGuildUserCount", guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "getGuildUsers") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const page = readStringParam(params, "page") ?? "1";
      const pageSize = readStringParam(params, "pageSize") ?? "50";
      return await handleKookAction(
        {
          action: "getGuildUsers",
          guildId,
          page: parseInt(page, 10),
          pageSize: parseInt(pageSize, 10),
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    // Channel Actions
    if (mappedAction === "getChannel") {
      const channelId = readStringParam(params, "channelId", { required: true });
      return await handleKookAction(
        { action: "getChannel", channelId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "getChannelList") {
      const guildId = readStringParam(params, "guildId", { required: true });
      return await handleKookAction(
        { action: "getChannelList", guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "getChannelUserList") {
      const channelId = readStringParam(params, "channelId", { required: true });
      return await handleKookAction(
        { action: "getChannelUserList", channelId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    // Role Management
    if (mappedAction === "roleInfo") {
      const guildId = readStringParam(params, "guildId", { required: true });
      return await handleKookAction(
        { action: "roleInfo", guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "roleCreate") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      return await handleKookAction(
        { action: "roleCreate", guildId, name, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "roleUpdate") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const roleId = readStringParam(params, "roleId", { required: true });
      return await handleKookAction(
        { action: "roleUpdate", guildId, roleId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "roleDelete") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const roleId = readStringParam(params, "roleId", { required: true });
      return await handleKookAction(
        { action: "roleDelete", guildId, roleId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "roleGrant") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const roleId = readStringParam(params, "roleId", { required: true });
      return await handleKookAction(
        { action: "roleGrant", guildId, userId, roleId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "roleRevoke") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const roleId = readStringParam(params, "roleId", { required: true });
      return await handleKookAction(
        { action: "roleRevoke", guildId, userId, roleId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    // Channel Management
    if (mappedAction === "createChannel") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      return await handleKookAction(
        { action: "createChannel", guildId, name, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "updateChannel") {
      const channelId = readStringParam(params, "channelId", { required: true });
      return await handleKookAction(
        { action: "updateChannel", channelId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "deleteChannel") {
      const channelId = readStringParam(params, "channelId", { required: true });
      return await handleKookAction(
        { action: "deleteChannel", channelId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "moveUser") {
      const userId = readStringParam(params, "userId", { required: true });
      const targetChannelId = readStringParam(params, "targetChannelId", { required: true });
      return await handleKookAction(
        { action: "moveUser", userId, targetChannelId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    // Member & Moderation
    if (mappedAction === "updateNickname") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const nickname = readStringParam(params, "nickname", { required: true });
      return await handleKookAction(
        { action: "updateNickname", guildId, userId, nickname, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "kickUser") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      return await handleKookAction(
        { action: "kickUser", guildId, userId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "leaveGuild") {
      const guildId = readStringParam(params, "guildId", { required: true });
      return await handleKookAction(
        { action: "leaveGuild", guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    // Emoji Management
    if (mappedAction === "emojiList") {
      const guildId = readStringParam(params, "guildId", { required: true });
      return await handleKookAction(
        { action: "emojiList", guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "emojiCreate") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const emoji = readStringParam(params, "emoji", { required: true });
      return await handleKookAction(
        { action: "emojiCreate", guildId, name, emoji, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "emojiUpdate") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const emojiId = readStringParam(params, "emojiId", { required: true });
      return await handleKookAction(
        { action: "emojiUpdate", guildId, emojiId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "emojiDelete") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const emojiId = readStringParam(params, "emojiId", { required: true });
      return await handleKookAction(
        { action: "emojiDelete", guildId, emojiId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    // Mute Management
    if (mappedAction === "muteList") {
      const guildId = readStringParam(params, "guildId", { required: true });
      return await handleKookAction(
        { action: "muteList", guildId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "muteCreate") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      return await handleKookAction(
        { action: "muteCreate", guildId, userId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    if (mappedAction === "muteDelete") {
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      return await handleKookAction(
        { action: "muteDelete", guildId, userId, accountId: accountId ?? undefined },
        cfg,
      );
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
