import type { ChannelMessageActionAdapter } from "../types.js";
import { LinqClient } from "../../../linq/client.js";
import { resolveLinqAccount } from "../../../linq/accounts.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { jsonResult } from "../../../agents/tools/common.js";

const LINQ_REACTION_MAP: Record<string, string> = {
  love: "love",
  like: "like",
  dislike: "dislike",
  laugh: "laugh",
  emphasize: "emphasize",
  question: "question",
};

export const linqMessageActions: ChannelMessageActionAdapter = {
  listActions: () => ["send", "react"],
  supportsAction: ({ action }) => action !== "send",
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }
    if (action !== "react") {
      return jsonResult({ ok: false, error: `Unsupported action: ${action}` });
    }
    const messageId = params.messageId as string | undefined;
    if (!messageId) {
      return jsonResult({ ok: false, error: "messageId is required for react action" });
    }
    const emoji = params.emoji as string | undefined;
    if (!emoji) {
      return jsonResult({ ok: false, error: "emoji is required for react action" });
    }
    const operation = (params.operation as string | undefined) ?? "add";
    const account = resolveLinqAccount({ cfg: cfg as OpenClawConfig, accountId });
    const token = account.config.apiToken;
    if (!token) {
      return jsonResult({ ok: false, error: "LINQ API token not configured" });
    }
    const client = new LinqClient(token);

    const reactionType = LINQ_REACTION_MAP[emoji.toLowerCase()] ?? "custom";
    const customEmoji = reactionType === "custom" ? emoji : undefined;

    try {
      await client.addReaction(messageId, {
        operation: operation === "remove" ? "remove" : "add",
        type: reactionType as "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "custom",
        custom_emoji: customEmoji,
        part_index: params.partIndex as number | undefined,
      });
      return jsonResult({ ok: true });
    } catch (error) {
      return jsonResult({ ok: false, error: String(error) });
    }
  },
};
