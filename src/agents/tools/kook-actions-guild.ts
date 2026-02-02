import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { KookActionConfig } from "../../config/config.js";
import {
  createKookChannel,
  createKookEmoji,
  createKookGuildMute,
  createKookRole,
  deleteKookChannel,
  deleteKookEmoji,
  deleteKookGuildMute,
  deleteKookRole,
  getKookChannelList,
  getKookEmojiList,
  getKookGuild,
  getKookGuildList,
  getKookGuildMuteList,
  getKookGuildUsers,
  getKookRoleList,
  grantKookRole,
  kickKookGuildUser,
  leaveKookGuild,
  moveKookUser,
  revokeKookRole,
  updateKookChannel,
  updateKookEmoji,
  updateKookNickname,
  updateKookRole,
} from "../../kook/api.js";
import { type ActionGate, jsonResult, readNumberParam, readStringParam } from "./common.js";

function readTokenParam(params: Record<string, unknown>): string {
  const token = readStringParam(params, "token", { required: true });
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new Error("KOOK token is required");
  }
  return token;
}

export async function handleKookGuildAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<KookActionConfig>,
): Promise<AgentToolResult<unknown>> {
  const _accountId = readStringParam(params, "accountId");
  void _accountId;
  const token = readTokenParam(params);

  switch (action) {
    // Guild Info
    case "getGuild": {
      if (!isActionEnabled("guildInfo")) {
        throw new Error("KOOK guild info is disabled.");
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
          enableOpen: guild.enableOpen,
          openId: guild.openId,
          defaultChannelId: guild.defaultChannelId,
          welcomeChannelId: guild.welcomeChannelId,
          roles: guild.roles,
          channels: guild.channels,
        },
      });
    }

    case "getGuildList": {
      if (!isActionEnabled("guildInfo")) {
        throw new Error("KOOK guild list is disabled.");
      }
      const guilds = await getKookGuildList(params.token as string);

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
          defaultChannelId: g.defaultChannelId,
          welcomeChannelId: g.welcomeChannelId,
        })),
      });
    }

    case "getGuildUserCount": {
      if (!isActionEnabled("guildInfo")) {
        throw new Error("KOOK guild user count is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });

      const counts = await getKookGuildUsers({
        token: params.token as string,
        guildId,
        page: 1,
        pageSize: 1,
      });

      return jsonResult({
        ok: true,
        userCount: counts.meta.total,
        onlineCount: counts.items.filter((u) => u.online).length,
        offlineCount: counts.items.filter((u) => !u.online).length,
      });
    }

    case "getGuildUsers": {
      if (!isActionEnabled("memberInfo")) {
        throw new Error("KOOK member info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const page = readNumberParam(params, "page", {}) ?? 1;
      const pageSize = readNumberParam(params, "pageSize", {}) ?? 50;

      const result = await getKookGuildUsers({
        token: params.token as string,
        guildId,
        page,
        pageSize,
      });

      return jsonResult({
        ok: true,
        users: result.items.map((u) => ({
          id: u.id,
          username: u.username,
          nickname: u.nickname,
          identifyNum: u.identifyNum,
          online: u.online,
          bot: u.bot,
          status: u.status,
          avatar: u.avatar,
          vipAvatar: u.vipAvatar,
          roles: u.roles,
          joinedAt: u.joinedAt,
          activeTime: u.activeTime,
        })),
        meta: result.meta,
      });
    }

    case "updateNickname": {
      if (!isActionEnabled("memberInfo")) {
        throw new Error("KOOK nickname update is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const nickname = readStringParam(params, "nickname", { required: true });

      await updateKookNickname({
        token: params.token as string,
        guildId,
        userId,
        nickname,
      });

      return jsonResult({ ok: true });
    }

    case "kickUser": {
      if (!isActionEnabled("moderation")) {
        throw new Error("KOOK kick is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });

      await kickKookGuildUser({
        token: params.token as string,
        guildId,
        userId,
      });

      return jsonResult({ ok: true });
    }

    case "leaveGuild": {
      if (!isActionEnabled("guildInfo")) {
        throw new Error("KOOK guild leave is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });

      await leaveKookGuild({
        token: params.token as string,
        guildId,
      });

      return jsonResult({ ok: true });
    }

    // Channel Management
    case "getChannel": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("KOOK channel info is disabled.");
      }
      const channelId = readStringParam(params, "channelId", { required: true });

      // Use existing getKookChannel from api.ts
      const channel = await (
        await import("../../kook/api.js")
      ).getKookChannel({
        token: params.token as string,
        channelId,
      });

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

    case "getChannelList": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("KOOK channel list is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const type = readNumberParam(params, "type");

      const result = await getKookChannelList({
        token: params.token as string,
        guildId,
        type: type as 1 | 2 | undefined,
      });

      return jsonResult({
        ok: true,
        channels: result.items,
        meta: result.meta,
      });
    }

    case "createChannel": {
      if (!isActionEnabled("channels")) {
        throw new Error("KOOK channel creation is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const type = readNumberParam(params, "type", {}) ?? 1;
      const parentId = readStringParam(params, "parentId");
      const limitAmount = readNumberParam(params, "limitAmount");

      const channel = await createKookChannel({
        token: params.token as string,
        guildId,
        name,
        type: type as 1 | 2,
        parentId,
        limitAmount: limitAmount ?? undefined,
      });

      return jsonResult({ ok: true, channel });
    }

    case "updateChannel": {
      if (!isActionEnabled("channels")) {
        throw new Error("KOOK channel update is disabled.");
      }
      const channelId = readStringParam(params, "channelId", { required: true });
      const name = readStringParam(params, "name");
      const topic = readStringParam(params, "topic");
      const parentId = readStringParam(params, "parentId");
      const slowMode = readNumberParam(params, "slowMode");

      const channel = await updateKookChannel({
        token: params.token as string,
        channelId,
        name,
        topic,
        parentId,
        slowMode,
      });

      return jsonResult({ ok: true, channel });
    }

    case "deleteChannel": {
      if (!isActionEnabled("channels")) {
        throw new Error("KOOK channel deletion is disabled.");
      }
      const channelId = readStringParam(params, "channelId", { required: true });

      await deleteKookChannel({
        token: params.token as string,
        channelId,
      });

      return jsonResult({ ok: true });
    }

    case "moveUser": {
      if (!isActionEnabled("voiceStatus")) {
        throw new Error("KOOK voice management is disabled.");
      }
      const userId = readStringParam(params, "userId", { required: true });
      const targetChannelId = readStringParam(params, "targetChannelId", { required: true });

      await moveKookUser({
        token: params.token as string,
        userId,
        targetChannelId,
      });

      return jsonResult({ ok: true });
    }

    // Role Management
    case "roleInfo": {
      if (!isActionEnabled("roleInfo")) {
        throw new Error("KOOK role info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });

      const roles = await getKookRoleList({
        token: params.token as string,
        guildId,
      });

      return jsonResult({
        ok: true,
        roles,
      });
    }

    case "roleCreate": {
      if (!isActionEnabled("roles")) {
        throw new Error(
          "KOOK role creation is disabled. Enable it by setting 'channels.kook.actions.roles: true' in your config.",
        );
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const color = readNumberParam(params, "color");
      const permissions = readNumberParam(params, "permissions");

      const role = await createKookRole({
        token: params.token as string,
        guildId,
        name,
        color,
        permissions,
      });

      return jsonResult({ ok: true, role });
    }

    case "roleUpdate": {
      if (!isActionEnabled("roles")) {
        throw new Error(
          "KOOK role update is disabled. Enable it by setting 'channels.kook.actions.roles: true' in your config.",
        );
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const roleId = readNumberParam(params, "roleId", { required: true })!;
      const name = readStringParam(params, "name");
      const color = readNumberParam(params, "color");
      const permissions = readNumberParam(params, "permissions");

      const role = await updateKookRole({
        token: params.token as string,
        guildId,
        roleId,
        name,
        color: color ?? undefined,
        permissions: permissions ?? undefined,
      });

      return jsonResult({ ok: true, role });
    }

    case "roleDelete": {
      if (!isActionEnabled("roles")) {
        throw new Error(
          "KOOK role deletion is disabled. Enable it by setting 'channels.kook.actions.roles: true' in your config.",
        );
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const roleId = readNumberParam(params, "roleId", { required: true })!;

      await deleteKookRole({
        token: params.token as string,
        guildId,
        roleId,
      });

      return jsonResult({ ok: true });
    }

    case "roleGrant": {
      if (!isActionEnabled("roles")) {
        throw new Error(
          "KOOK role grant is disabled. Enable it by setting 'channels.kook.actions.roles: true' in your config.",
        );
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const roleId = readNumberParam(params, "roleId", { required: true })!;

      await grantKookRole({
        token: params.token as string,
        guildId,
        userId,
        roleId,
      });

      return jsonResult({ ok: true });
    }

    case "roleRevoke": {
      if (!isActionEnabled("roles")) {
        throw new Error(
          "KOOK role revoke is disabled. Enable it by setting 'channels.kook.actions.roles: true' in your config.",
        );
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const roleId = readNumberParam(params, "roleId", { required: true })!;

      await revokeKookRole({
        token: params.token as string,
        guildId,
        userId,
        roleId,
      });

      return jsonResult({ ok: true });
    }

    // Emoji Management
    case "emojiList": {
      if (!isActionEnabled("emojiList")) {
        throw new Error("KOOK emoji list is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const page = readNumberParam(params, "page", {}) ?? 1;
      const pageSize = readNumberParam(params, "pageSize", {}) ?? 50;

      const result = await getKookEmojiList({
        token: params.token as string,
        guildId,
        page,
        pageSize,
      });

      return jsonResult({
        ok: true,
        emojis: result.items,
        meta: result.meta,
      });
    }

    case "emojiCreate": {
      if (!isActionEnabled("emojiUploads")) {
        throw new Error("KOOK emoji upload is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const emoji = readStringParam(params, "emoji", { required: true });

      const emojiData = await createKookEmoji({
        token: params.token as string,
        guildId,
        name,
        emoji,
      });

      return jsonResult({ ok: true, emoji: emojiData });
    }

    case "emojiUpdate": {
      if (!isActionEnabled("emojiUploads")) {
        throw new Error("KOOK emoji update is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const emojiId = readStringParam(params, "emojiId", { required: true });
      const name = readStringParam(params, "name");
      const emoji = readStringParam(params, "emoji");

      const emojiData = await updateKookEmoji({
        token: params.token as string,
        guildId,
        emojiId,
        name,
        emoji,
      });

      return jsonResult({ ok: true, emoji: emojiData });
    }

    case "emojiDelete": {
      if (!isActionEnabled("emojiUploads")) {
        throw new Error("KOOK emoji deletion is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const emojiId = readStringParam(params, "emojiId", { required: true });

      await deleteKookEmoji({
        token: params.token as string,
        guildId,
        emojiId,
      });

      return jsonResult({ ok: true });
    }

    // Mute Management
    case "muteList": {
      if (!isActionEnabled("moderation")) {
        throw new Error("KOOK mute list is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });

      const result = await getKookGuildMuteList({
        token: params.token as string,
        guildId,
      });

      return jsonResult({
        ok: true,
        mutes: result.items,
      });
    }

    case "muteCreate": {
      if (!isActionEnabled("moderation")) {
        throw new Error("KOOK mute creation is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const type = readNumberParam(params, "type", { required: true })!;
      const duration = readNumberParam(params, "duration");

      await createKookGuildMute({
        token: params.token as string,
        guildId,
        userId,
        type,
        duration: duration ?? undefined,
      });

      return jsonResult({ ok: true });
    }

    case "muteDelete": {
      if (!isActionEnabled("moderation")) {
        throw new Error("KOOK mute deletion is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const userId = readStringParam(params, "userId", { required: true });
      const type = readNumberParam(params, "type", { required: true })!;

      await deleteKookGuildMute({
        token: params.token as string,
        guildId,
        userId,
        type,
      });

      return jsonResult({ ok: true });
    }

    default:
      throw new Error(`Unknown KOOK guild action: ${action}`);
  }
}
