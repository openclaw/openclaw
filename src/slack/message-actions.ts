import { createActionGate } from "../agents/tools/common.js";
import type { ChannelMessageActionName, ChannelToolSend } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { listEnabledSlackAccounts } from "./accounts.js";

export function listSlackMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const accounts = listEnabledSlackAccounts(cfg).filter(
    (account) => account.botTokenSource !== "none",
  );
  if (accounts.length === 0) {
    return [];
  }

  const isActionEnabled = (key: string, defaultValue = true) => {
    for (const account of accounts) {
      const gate = createActionGate(
        (account.actions ?? cfg.channels?.slack?.actions) as Record<string, boolean | undefined>,
      );
      if (gate(key, defaultValue)) {
        return true;
      }
    }
    return false;
  };

  const actions = new Set<ChannelMessageActionName>(["send"]);
  if (isActionEnabled("reactions")) {
    actions.add("react");
    actions.add("reactions");
  }
  if (isActionEnabled("messages")) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
    actions.add("download-file");
  }
  if (isActionEnabled("pins")) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }
  if (isActionEnabled("memberInfo")) {
    actions.add("member-info");
  }
  if (isActionEnabled("emojiList")) {
    actions.add("emoji-list");
  }
  return Array.from(actions);
}

export function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (action !== "sendMessage") {
    return null;
  }
  const to = typeof args.to === "string" ? args.to : undefined;
  if (!to) {
    return null;
  }
  const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  return { to, accountId };
}
