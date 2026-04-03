import { loadConfig } from "../../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  removeChannelAllowFromStoreEntry,
} from "../../pairing/pairing-store.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function validateSendVerification(
  params: Record<string, unknown>,
): params is { channel: string; channelUserId: string; code: string } {
  return (
    typeof params.channel === "string" &&
    typeof params.channelUserId === "string" &&
    typeof params.code === "string" &&
    /^\d{6}$/.test(params.code)
  );
}

function validateAllowFromEntry(
  params: Record<string, unknown>,
): params is { channel: string; channelUserId: string; accountId?: string } {
  return (
    typeof params.channel === "string" &&
    typeof params.channelUserId === "string" &&
    params.channelUserId.trim().length > 0
  );
}

export const botMemberHandlers: GatewayRequestHandlers = {
  "bot-member.send-verification": async ({ params, respond, context }) => {
    if (!validateSendVerification(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid params: requires channel (string), channelUserId (string), code (6-digit string)",
        ),
      );
      return;
    }

    const { channel, channelUserId, code } = params;

    if (channel !== "telegram") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
      );
      return;
    }

    const text = [
      "Your OpenClaw verification code:",
      "",
      `<b>${code}</b>`,
      "",
      "Enter this code on the registration page to verify your identity.",
      "This code expires in 10 minutes.",
    ].join("\n");

    try {
      const result = await sendMessageTelegram(channelUserId, text, {
        silent: true,
        textMode: "html",
      });
      context.logGateway.info(
        `bot-member verification sent channel=${channel} userId=${channelUserId}`,
      );
      respond(true, { messageId: result.messageId, chatId: result.chatId }, undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.logGateway.warn(
        `bot-member verification send failed channel=${channel} userId=${channelUserId}: ${msg}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to send verification message: ${msg}`),
      );
    }
  },

  "bot-member.allow-from.add": async ({ params, respond, context }) => {
    if (!validateAllowFromEntry(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid params: requires channel (string), channelUserId (non-empty string)",
        ),
      );
      return;
    }

    const { channel, channelUserId, accountId } = params as {
      channel: string;
      channelUserId: string;
      accountId?: string;
    };

    try {
      const result = await addChannelAllowFromStoreEntry({
        channel: channel as import("../../channels/plugins/types.js").ChannelId,
        entry: channelUserId,
        accountId,
      });
      context.logGateway.info(
        `bot-member allow-from add channel=${channel} userId=${channelUserId} changed=${result.changed}`,
      );
      respond(true, { changed: result.changed, count: result.allowFrom.length }, undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.logGateway.warn(
        `bot-member allow-from add failed channel=${channel} userId=${channelUserId}: ${msg}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to add allow-from entry: ${msg}`),
      );
    }
  },

  "bot-member.allow-from.remove": async ({ params, respond, context }) => {
    if (!validateAllowFromEntry(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid params: requires channel (string), channelUserId (non-empty string)",
        ),
      );
      return;
    }

    const { channel, channelUserId, accountId } = params as {
      channel: string;
      channelUserId: string;
      accountId?: string;
    };

    try {
      const result = await removeChannelAllowFromStoreEntry({
        channel: channel as import("../../channels/plugins/types.js").ChannelId,
        entry: channelUserId,
        accountId,
      });
      context.logGateway.info(
        `bot-member allow-from remove channel=${channel} userId=${channelUserId} changed=${result.changed}`,
      );
      respond(true, { changed: result.changed, count: result.allowFrom.length }, undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.logGateway.warn(
        `bot-member allow-from remove failed channel=${channel} userId=${channelUserId}: ${msg}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to remove allow-from entry: ${msg}`),
      );
    }
  },
};
