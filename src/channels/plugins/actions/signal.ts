import { createActionGate, jsonResult, readStringParam } from "../../../agents/tools/common.js";
import { listEnabledSignalAccounts, resolveSignalAccount } from "../../../signal/accounts.js";
import {
  updateGroupSignal,
  addGroupMemberSignal,
  removeGroupMemberSignal,
  quitGroupSignal,
  listGroupMembersSignal,
} from "../../../signal/groups.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { sendReactionSignal, removeReactionSignal } from "../../../signal/send-reactions.js";
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

function readSignalGroupIdParam(params: Record<string, unknown>): string {
  const raw =
    readStringParam(params, "groupId") ??
    readStringParam(params, "to", { required: true, label: "groupId (Signal group ID)" });
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Signal group management requires groupId.");
  }
  // Strip signal:group: / group: prefix for convenience
  return trimmed
    .replace(/^signal:group:/i, "")
    .replace(/^group:/i, "")
    .trim();
}

const GROUP_MANAGEMENT_ACTIONS: ChannelMessageActionName[] = [
  "renameGroup",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
  "member-info",
];

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

    const groupManagementEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("groupManagement"),
    );
    if (groupManagementEnabled) {
      for (const action of GROUP_MANAGEMENT_ACTIONS) {
        actions.add(action);
      }
    }

    return Array.from(actions);
  },
  supportsAction: ({ action }) => {
    if (action === "send") {
      return false;
    }
    if (action === "react") {
      return true;
    }
    return GROUP_MANAGEMENT_ACTIONS.includes(action);
  },

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

    const resolvedAccountId = accountId ?? undefined;

    const actionConfig = resolveSignalAccount({ cfg, accountId }).config.actions;
    if (!createActionGate(actionConfig)("groupManagement")) {
      throw new Error("Signal group management is disabled via actions.groupManagement.");
    }

    if (action === "renameGroup") {
      const groupId = readSignalGroupIdParam(params);
      const name = readStringParam(params, "name") ?? readStringParam(params, "displayName");
      if (!name?.trim()) {
        throw new Error("Signal renameGroup requires name parameter.");
      }
      await updateGroupSignal(groupId, { name: name.trim() }, { accountId: resolvedAccountId });
      return jsonResult({ ok: true, renamed: groupId, name: name.trim() });
    }

    if (action === "addParticipant") {
      const groupId = readSignalGroupIdParam(params);
      const member =
        readStringParam(params, "participant") ??
        readStringParam(params, "member") ??
        readStringParam(params, "address");
      if (!member?.trim()) {
        throw new Error(
          "Signal addParticipant requires participant parameter (phone number or UUID).",
        );
      }
      await addGroupMemberSignal(groupId, member.trim(), { accountId: resolvedAccountId });
      return jsonResult({ ok: true, added: member.trim(), groupId });
    }

    if (action === "removeParticipant") {
      const groupId = readSignalGroupIdParam(params);
      const member =
        readStringParam(params, "participant") ??
        readStringParam(params, "member") ??
        readStringParam(params, "address");
      if (!member?.trim()) {
        throw new Error(
          "Signal removeParticipant requires participant parameter (phone number or UUID).",
        );
      }
      await removeGroupMemberSignal(groupId, member.trim(), { accountId: resolvedAccountId });
      return jsonResult({ ok: true, removed: member.trim(), groupId });
    }

    if (action === "leaveGroup") {
      const groupId = readSignalGroupIdParam(params);
      await quitGroupSignal(groupId, { accountId: resolvedAccountId });
      return jsonResult({ ok: true, left: groupId });
    }

    if (action === "member-info") {
      const groupId = readSignalGroupIdParam(params);
      const members = await listGroupMembersSignal(groupId, { accountId: resolvedAccountId });
      return jsonResult({ ok: true, groupId, members });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
