import {
  createActionGate,
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "../../../agents/tools/common.js";
import { listEnabledSignalAccounts, resolveSignalAccount } from "../../../signal/accounts.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { sendReactionSignal, removeReactionSignal } from "../../../signal/send-reactions.js";
import {
  sendRemoteDeleteSignal,
  sendPollCreateSignal,
  sendPollVoteSignal,
  sendPollTerminateSignal,
} from "../../../signal/send.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";

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

    const unsendEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("unsend"),
    );
    if (unsendEnabled) {
      actions.add("unsend");
    }

    const pollEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("poll"),
    );
    if (pollEnabled) {
      actions.add("poll");
    }

    const pollVoteEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("pollVote"),
    );
    if (pollVoteEnabled) {
      actions.add("pollVote");
    }

    const pollTerminateEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("pollTerminate"),
    );
    if (pollTerminateEnabled) {
      actions.add("pollTerminate");
    }

    return Array.from(actions);
  },
  supportsAction: ({ action }) => action !== "send",

  handleAction: async ({ action, params, cfg, accountId }) => {
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

      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });
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
        await removeReactionSignal(target.recipient ?? "", timestamp, emoji, {
          accountId: accountId ?? undefined,
          groupId: target.groupId,
          targetAuthor,
          targetAuthorUuid,
        });
        return jsonResult({ ok: true, removed: emoji });
      }

      if (!emoji) {
        throw new Error("Emoji required to add reaction.");
      }
      await sendReactionSignal(target.recipient ?? "", timestamp, emoji, {
        accountId: accountId ?? undefined,
        groupId: target.groupId,
        targetAuthor,
        targetAuthorUuid,
      });
      return jsonResult({ ok: true, added: emoji });
    }

    if (action === "unsend") {
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      const isActionEnabled = createActionGate(actionConfig);
      if (!isActionEnabled("unsend")) {
        throw new Error("Signal unsend is disabled via actions.unsend.");
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

      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });

      const timestamp = parseInt(messageId, 10);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error(`Invalid messageId: ${messageId}. Expected positive numeric timestamp.`);
      }

      const deleted = await sendRemoteDeleteSignal(recipientRaw, timestamp, {
        accountId: accountId ?? undefined,
      });
      if (!deleted) {
        throw new Error(`Failed to delete message ${messageId}.`);
      }
      return jsonResult({ ok: true, deleted: messageId });
    }

    if (action === "poll") {
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      const isActionEnabled = createActionGate(actionConfig);
      if (!isActionEnabled("poll")) {
        throw new Error("Signal poll creation is disabled via actions.poll.");
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

      const question = readStringParam(params, "pollQuestion", {
        required: true,
      });
      const options =
        readStringArrayParam(params, "pollOption", {
          required: true,
        }) ?? [];
      const allowMultiple = typeof params.pollMulti === "boolean" ? params.pollMulti : true;

      const result = await sendPollCreateSignal(recipientRaw, {
        question,
        options,
        allowMultiple,
        accountId: accountId ?? undefined,
      });

      return jsonResult({
        ok: true,
        messageId: result.messageId,
        question,
        options,
        allowMultiple,
      });
    }

    if (action === "pollVote") {
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      const isActionEnabled = createActionGate(actionConfig);
      if (!isActionEnabled("pollVote")) {
        throw new Error("Signal poll voting is disabled via actions.pollVote.");
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

      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (poll timestamp)",
      });

      const pollAuthor =
        readStringParam(params, "targetAuthorUuid") ?? readStringParam(params, "targetAuthor");
      if (!pollAuthor) {
        throw new Error(
          "targetAuthor or targetAuthorUuid required for poll voting (poll creator's identifier).",
        );
      }

      const pollOptions = params.pollOption ?? params.pollOptions;
      if (!Array.isArray(pollOptions) || pollOptions.length === 0) {
        throw new Error("pollOptions (array of option indexes) is required");
      }

      const optionIndexes = pollOptions.map((opt) => {
        const idx = typeof opt === "number" ? opt : parseInt(String(opt), 10);
        if (!Number.isFinite(idx) || idx < 0) {
          throw new Error(`Invalid poll option index: ${opt}`);
        }
        return idx;
      });

      const timestamp = parseInt(messageId, 10);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error(`Invalid messageId: ${messageId}. Expected positive numeric timestamp.`);
      }

      const result = await sendPollVoteSignal(recipientRaw, {
        pollAuthor,
        pollTimestamp: timestamp,
        optionIndexes,
        accountId: accountId ?? undefined,
      });

      return jsonResult({ ok: true, messageId: result.messageId, voted: optionIndexes });
    }

    if (action === "pollTerminate") {
      const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
      const isActionEnabled = createActionGate(actionConfig);
      if (!isActionEnabled("pollTerminate")) {
        throw new Error("Signal poll termination is disabled via actions.pollTerminate.");
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

      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (poll timestamp)",
      });

      const timestamp = parseInt(messageId, 10);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error(`Invalid messageId: ${messageId}. Expected positive numeric timestamp.`);
      }

      const result = await sendPollTerminateSignal(recipientRaw, {
        pollTimestamp: timestamp,
        accountId: accountId ?? undefined,
      });

      return jsonResult({ ok: true, messageId: result.messageId, closed: messageId });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
