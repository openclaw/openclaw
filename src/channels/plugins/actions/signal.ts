import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../../agents/tools/common.js";
import { listEnabledSignalAccounts, resolveSignalAccount } from "../../../signal/accounts.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { sendReactionSignal, removeReactionSignal } from "../../../signal/send-reactions.js";
import { listStickerPacksSignal, sendStickerSignal } from "../../../signal/send.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";
import { resolveReactionMessageId } from "./reaction-message-id.js";

const providerId = "signal";
const GROUP_PREFIX = "group:";

function normalizeSignalReactionRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return withoutSignal;
  }
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    return withoutSignal.slice("uuid:".length).trim();
  }
  return withoutSignal;
}

function resolveSignalReactionTarget(raw: string): { recipient?: string; groupId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return {};
  }
  if (withoutSignal.toLowerCase().startsWith(GROUP_PREFIX)) {
    const groupId = withoutSignal.slice(GROUP_PREFIX.length).trim();
    return groupId ? { groupId } : {};
  }
  return { recipient: normalizeSignalReactionRecipient(withoutSignal) };
}

function parseSignalStickerParams(params: Record<string, unknown>): {
  packId: string;
  stickerId: number;
} {
  const stickerIds = readStringArrayParam(params, "stickerId");
  const packIdParam = readStringParam(params, "packId");
  const stickerIdParam = readNumberParam(params, "stickerNum", {
    integer: true,
  });
  const firstSticker = stickerIds?.[0]?.trim();
  if (firstSticker?.includes(":")) {
    const [packIdRaw, stickerIdRaw] = firstSticker.split(":", 2);
    const packId = packIdRaw?.trim();
    const stickerId = Number.parseInt(stickerIdRaw?.trim() ?? "", 10);
    if (!packId || !Number.isFinite(stickerId) || stickerId < 0) {
      throw new Error("Signal stickerId must be in packId:stickerId format.");
    }
    return { packId, stickerId };
  }
  const packId = packIdParam?.trim();
  if (!packId) {
    throw new Error("Signal sticker requires packId or stickerId=packId:stickerId.");
  }
  const stickerId =
    stickerIdParam ??
    (() => {
      if (!firstSticker) {
        return Number.NaN;
      }
      return Number.parseInt(firstSticker, 10);
    })();
  if (!Number.isFinite(stickerId) || stickerId < 0) {
    throw new Error("Signal sticker requires a non-negative sticker ID.");
  }
  return {
    packId,
    stickerId: Math.trunc(stickerId),
  };
}

function readSignalRecipientParam(params: Record<string, unknown>): string {
  return (
    readStringParam(params, "recipient") ??
    readStringParam(params, "to", {
      required: true,
      label: "recipient (phone number, UUID, or group)",
    })
  );
}

async function mutateSignalReaction(params: {
  accountId?: string;
  target: { recipient?: string; groupId?: string };
  timestamp: number;
  emoji: string;
  remove?: boolean;
  targetAuthor?: string;
  targetAuthorUuid?: string;
}) {
  const options = {
    accountId: params.accountId,
    groupId: params.target.groupId,
    targetAuthor: params.targetAuthor,
    targetAuthorUuid: params.targetAuthorUuid,
  };
  if (params.remove) {
    await removeReactionSignal(
      params.target.recipient ?? "",
      params.timestamp,
      params.emoji,
      options,
    );
    return jsonResult({ ok: true, removed: params.emoji });
  }
  await sendReactionSignal(params.target.recipient ?? "", params.timestamp, params.emoji, options);
  return jsonResult({ ok: true, added: params.emoji });
}

export const signalMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledSignalAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const configuredAccounts = accounts.filter((account) => account.configured);
    if (configuredAccounts.length === 0) {
      return [];
    }

    const actions = new Set<ChannelMessageActionName>(["send"]);

    const reactionsEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("reactions"),
    );
    if (reactionsEnabled) {
      actions.add("react");
    }
    const stickerEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("stickers", false),
    );
    if (stickerEnabled) {
      actions.add("sticker");
      actions.add("sticker-search");
    }

    return Array.from(actions);
  },
  supportsAction: ({ action }) =>
    action === "react" || action === "sticker" || action === "sticker-search",

  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
      // Check reaction level first
      const reactionLevelInfo = resolveSignalReactionLevel({
        cfg,
        accountId: accountId ?? undefined,
      });
      if (!reactionLevelInfo.agentReactionsEnabled) {
        throw new Error(
          `Signal agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
            `Set channels.signal.reactionLevel to "minimal" or "extensive" to enable.`,
        );
      }

      // Also check the action gate for backward compatibility
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      const isActionEnabled = createActionGate(actionConfig);
      if (!isActionEnabled("reactions")) {
        throw new Error("Signal reactions are disabled via actions.reactions.");
      }

      const recipientRaw =
        readStringParam(params, "recipient") ??
        readStringParam(params, "to", {
          required: true,
          label: "recipient (UUID, phone number, or group)",
        });
      const target = resolveSignalReactionTarget(recipientRaw);
      if (!target.recipient && !target.groupId) {
        throw new Error("recipient or group required");
      }

      const messageIdRaw = resolveReactionMessageId({ args: params, toolContext });
      const messageId = messageIdRaw != null ? String(messageIdRaw) : undefined;
      if (!messageId) {
        throw new Error(
          "messageId (timestamp) required. Provide messageId explicitly or react to the current inbound message.",
        );
      }
      const targetAuthor = readStringParam(params, "targetAuthor");
      const targetAuthorUuid = readStringParam(params, "targetAuthorUuid");
      if (target.groupId && !targetAuthor && !targetAuthorUuid) {
        throw new Error("targetAuthor or targetAuthorUuid required for group reactions.");
      }

      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;

      const timestamp = parseInt(messageId, 10);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid messageId: ${messageId}. Expected numeric timestamp.`);
      }

      if (remove) {
        if (!emoji) {
          throw new Error("Emoji required to remove reaction.");
        }
        return await mutateSignalReaction({
          accountId: accountId ?? undefined,
          target,
          timestamp,
          emoji,
          remove: true,
          targetAuthor,
          targetAuthorUuid,
        });
      }

      if (!emoji) {
        throw new Error("Emoji required to add reaction.");
      }
      return await mutateSignalReaction({
        accountId: accountId ?? undefined,
        target,
        timestamp,
        emoji,
        remove: false,
        targetAuthor,
        targetAuthorUuid,
      });
    }

    if (action === "sticker") {
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      if (!createActionGate(actionConfig)("stickers", false)) {
        throw new Error("Signal sticker actions are disabled via actions.stickers.");
      }
      const recipient = readSignalRecipientParam(params);
      const { packId, stickerId } = parseSignalStickerParams(params);
      const result = await sendStickerSignal(recipient, packId, stickerId, {
        accountId: accountId ?? undefined,
      });
      return jsonResult({
        ok: true,
        messageId: result.messageId,
        timestamp: result.timestamp,
        packId,
        stickerId,
      });
    }

    if (action === "sticker-search") {
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      if (!createActionGate(actionConfig)("stickers", false)) {
        throw new Error("Signal sticker actions are disabled via actions.stickers.");
      }
      const query = readStringParam(params, "query");
      const limit = readNumberParam(params, "limit", { integer: true });
      const normalizedQuery = query?.trim().toLowerCase();
      const packs = await listStickerPacksSignal({
        accountId: accountId ?? undefined,
      });
      const filtered = normalizedQuery
        ? packs.filter((pack) => {
            const fields = [
              typeof pack.packId === "string" ? pack.packId : "",
              typeof pack.id === "string" ? pack.id : "",
              typeof pack.title === "string" ? pack.title : "",
              typeof pack.author === "string" ? pack.author : "",
            ]
              .join(" ")
              .toLowerCase();
            return fields.includes(normalizedQuery);
          })
        : packs;
      const capped =
        typeof limit === "number" && limit > 0 ? filtered.slice(0, Math.trunc(limit)) : filtered;
      return jsonResult({ ok: true, packs: capped });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
