import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DiscordActionConfig } from "../../config/config.js";
import { banMemberDiscord, kickMemberDiscord, timeoutMemberDiscord } from "../../discord/send.js";
import { type ActionGate, jsonResult, readStringParam } from "./common.js";

export async function handleDiscordModerationAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
): Promise<AgentToolResult<unknown>> {
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
      const member = await timeoutMemberDiscord({
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
      await kickMemberDiscord({ guildId, userId, reason });
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
      await banMemberDiscord({
        guildId,
        userId,
        reason,
        deleteMessageDays,
      });
      return jsonResult({ ok: true });
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
