import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveKookAccount } from "../../kook/accounts.js";
import {
  getKookMe,
  getKookUser,
  getKookGuild,
  getKookGuildList,
  getKookGuildUserCount,
  getKookChannel,
  getKookChannelUserList,
} from "../../kook/api.js";
import { createActionGate, jsonResult, readStringParam } from "./common.js";
import { handleKookGuildAction } from "./kook-actions-guild.js";
import { handleKookMessagingAction } from "./kook-actions-messaging.js";

export async function handleKookAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const isActionEnabled = createActionGate(cfg.channels?.kook?.actions);

  // Resolve KOOK account and token
  const account = resolveKookAccount({
    cfg,
    accountId: accountId ?? undefined,
  });

  if (!account?.token) {
    throw new Error("KOOK bot token missing. Configure channels.kook with bot token.");
  }

  const token = account.token;

  // Add token to params for sub-handlers
  params.token = token;

  // ============================================================
  // User Actions
  // ============================================================

  if (action === "getMe") {
    if (!isActionEnabled("getMe")) {
      throw new Error("KOOK getMe action is disabled.");
    }
    const user = await getKookMe(token);
    return jsonResult({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        identifyNum: user.identifyNum,
        online: user.online,
        bot: user.bot,
        status: user.status,
        avatar: user.avatar,
        vipAvatar: user.vipAvatar,
        mobileVerified: user.mobileVerified,
      },
    });
  }

  if (action === "getUser") {
    if (!isActionEnabled("getUser")) {
      throw new Error("KOOK getUser action is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const guildId = readStringParam(params, "guildId");
    const user = await getKookUser({
      token,
      userId,
      guildId: guildId ?? undefined,
    });
    return jsonResult({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        identifyNum: user.identifyNum,
        online: user.online,
        bot: user.bot,
        status: user.status,
        avatar: user.avatar,
        vipAvatar: user.vipAvatar,
        mobileVerified: user.mobileVerified,
        roles: user.roles,
        joinedAt: user.joinedAt ? new Date(user.joinedAt).toISOString() : undefined,
        activeTime: user.activeTime ? new Date(user.activeTime).toISOString() : undefined,
      },
    });
  }

  // ============================================================
  // Guild Actions (Basic - Keep for backward compatibility)
  // ============================================================

  if (action === "getGuildList") {
    if (!isActionEnabled("guildInfo")) {
      throw new Error("KOOK getGuildList action is disabled.");
    }
    const guilds = await getKookGuildList(token);
    return jsonResult({
      ok: true,
      guilds: guilds.map((g) => ({
        id: g.id,
        name: g.name,
        topic: g.topic,
        userId: g.userId,
        icon: g.icon,
        region: g.region,
        enableOpen: g.enableOpen,
        openId: g.openId,
      })),
    });
  }

  if (action === "getGuild") {
    if (!isActionEnabled("guildInfo")) {
      throw new Error("KOOK getGuild action is disabled.");
    }
    const guildId = readStringParam(params, "guildId", { required: true });
    const guild = await getKookGuild({ token, guildId });
    return jsonResult({
      ok: true,
      guild: {
        id: guild.id,
        name: guild.name,
        topic: guild.topic,
        userId: guild.userId,
        icon: guild.icon,
        region: guild.region,
        defaultChannelId: guild.defaultChannelId,
        welcomeChannelId: guild.welcomeChannelId,
        roles: guild.roles?.map((r) => ({
          roleId: r.roleId,
          name: r.name,
          color: r.color,
          position: r.position,
        })),
        channels: guild.channels?.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          isCategory: c.isCategory,
          parentId: c.parentId,
          topic: c.topic,
        })),
      },
    });
  }

  if (action === "getGuildUserCount") {
    if (!isActionEnabled("guildInfo")) {
      throw new Error("KOOK getGuildUserCount action is disabled.");
    }
    const guildId = readStringParam(params, "guildId", { required: true });
    const counts = await getKookGuildUserCount({ token, guildId });
    return jsonResult({
      ok: true,
      userCount: counts.userCount,
      onlineCount: counts.onlineCount,
      offlineCount: counts.offlineCount,
    });
  }

  // ============================================================
  // Channel Actions (Basic - Keep for backward compatibility)
  // ============================================================

  if (action === "getChannel") {
    if (!isActionEnabled("channelInfo")) {
      throw new Error("KOOK getChannel action is disabled.");
    }
    const channelId = readStringParam(params, "channelId", { required: true });
    const channel = await getKookChannel({ token, channelId });
    return jsonResult({
      ok: true,
      channel: {
        id: channel.id,
        name: channel.name,
        guildId: channel.guildId,
        type: channel.type,
        topic: channel.topic,
        isCategory: channel.isCategory,
        parentId: channel.parentId,
        slowMode: channel.slowMode,
      },
    });
  }

  if (action === "getChannelUserList") {
    if (!isActionEnabled("channelInfo")) {
      throw new Error("KOOK getChannelUserList action is disabled.");
    }
    const channelId = readStringParam(params, "channelId", { required: true });
    const users = await getKookChannelUserList({ token, channelId });
    return jsonResult({
      ok: true,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        nickname: u.nickname,
        identifyNum: u.identifyNum,
        online: u.online,
        bot: u.bot,
        avatar: u.avatar,
      })),
    });
  }

  // ============================================================
  // Messaging Actions
  // ============================================================

  const messagingActions = new Set([
    "sendMessage",
    "readMessages",
    "fetchMessage",
    "editMessage",
    "deleteMessage",
    "react",
    "reactions",
    "removeReaction",
  ]);

  if (messagingActions.has(action)) {
    return await handleKookMessagingAction(action, params, isActionEnabled);
  }

  // ============================================================
  // Guild Extended Actions
  // ============================================================

  const guildActions = new Set([
    // Guild Info
    "getGuild",
    "getGuildList",
    "getGuildUserCount",
    "getGuildUsers",
    "updateNickname",
    "kickUser",
    "leaveGuild",
    // Channel Management
    "getChannel",
    "getChannelList",
    "createChannel",
    "updateChannel",
    "deleteChannel",
    "moveUser",
    // Role Management
    "roleInfo",
    "roleCreate",
    "roleUpdate",
    "roleDelete",
    "roleGrant",
    "roleRevoke",
    // Emoji Management
    "emojiList",
    "emojiCreate",
    "emojiUpdate",
    "emojiDelete",
    // Mute Management
    "muteList",
    "muteCreate",
    "muteDelete",
  ]);

  if (guildActions.has(action)) {
    return await handleKookGuildAction(action, params, isActionEnabled);
  }

  throw new Error(`Unknown KOOK action: ${action}`);
}
