import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { PermissionFlagsBits } from "discord-api-types/v10";
import type { DiscordActionConfig } from "../../config/config.js";
import {
  banMemberDiscord,
  hasGuildPermissionDiscord,
  kickMemberDiscord,
  timeoutMemberDiscord,
} from "../../discord/send.js";
import { type ActionGate, jsonResult, readStringParam } from "./common.js";

async function verifySenderModerationPermission(params: {
  guildId: string;
  senderUserId?: string;
  requiredPermissions: bigint[];
  accountId?: string;
}) {
  // CLI/manual flows may not have sender context; enforce only when present.
  if (!params.senderUserId) {
    return;
  }
  const hasPermission = await hasGuildPermissionDiscord(
    params.guildId,
    params.senderUserId,
    params.requiredPermissions,
    params.accountId ? { accountId: params.accountId } : undefined,
  );
  if (!hasPermission) {
    throw new Error("Sender does not have required permissions for this moderation action.");
  }
}

export async function handleDiscordModerationAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
): Promise<AgentToolResult<unknown>> {
  const accountId = readStringParam(params, "accountId");
  const senderUserId = readStringParam(params, "senderUserId");
  switch (action) {
    case "timeout": {
      if (!isActionEnabled("moderation", false)) {
        throw new Error("Discord moderation is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const durationMinutes =
        typeof params.durationMinutes === "number" && Number.isFinite(params.durationMinutes)
          ? params.durationMinutes
          : undefined;
      const until = readStringParam(params, "until");
      const reason = readStringParam(params, "reason");
      await verifySenderModerationPermission({
        guildId,
        senderUserId,
        requiredPermissions: [PermissionFlagsBits.ModerateMembers],
        accountId,
      });
      const member = accountId
        ? await timeoutMemberDiscord(
            {
              guildId,
              userId,
              durationMinutes,
              until,
              reason,
            },
            { accountId },
          )
        : await timeoutMemberDiscord({
            guildId,
            userId,
            durationMinutes,
            until,
            reason,
          });
      return jsonResult({ ok: true, member });
    }
    case "kick": {
      if (!isActionEnabled("moderation", false)) {
        throw new Error("Discord moderation is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const reason = readStringParam(params, "reason");
      await verifySenderModerationPermission({
        guildId,
        senderUserId,
        requiredPermissions: [PermissionFlagsBits.KickMembers],
        accountId,
      });
      if (accountId) {
        await kickMemberDiscord({ guildId, userId, reason }, { accountId });
      } else {
        await kickMemberDiscord({ guildId, userId, reason });
      }
      return jsonResult({ ok: true });
    }
    case "ban": {
      if (!isActionEnabled("moderation", false)) {
        throw new Error("Discord moderation is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const reason = readStringParam(params, "reason");
      const deleteMessageDays =
        typeof params.deleteMessageDays === "number" && Number.isFinite(params.deleteMessageDays)
          ? params.deleteMessageDays
          : undefined;
      await verifySenderModerationPermission({
        guildId,
        senderUserId,
        requiredPermissions: [PermissionFlagsBits.BanMembers],
        accountId,
      });
      if (accountId) {
        await banMemberDiscord(
          {
            guildId,
            userId,
            reason,
            deleteMessageDays,
          },
          { accountId },
        );
      } else {
        await banMemberDiscord({
          guildId,
          userId,
          reason,
          deleteMessageDays,
        });
      }
      return jsonResult({ ok: true });
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
