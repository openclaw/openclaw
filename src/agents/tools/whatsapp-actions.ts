import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { sendReactionWhatsApp } from "../../web/outbound.js";
import { getActiveWebListener } from "../../web/active-listener.js";
import { createActionGate, jsonResult, readReactionParams, readStringParam } from "./common.js";

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled = createActionGate(cfg.channels?.whatsapp?.actions);

  if (action === "react") {
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const accountId = readStringParam(params, "accountId");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;
    const resolvedEmoji = remove ? "" : emoji;
    await sendReactionWhatsApp(chatJid, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: accountId ?? undefined,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "list-groups") {
    const accountId = readStringParam(params, "accountId");
    const listener = getActiveWebListener(accountId ?? undefined);
    if (!listener) {
      throw new Error(
        `No active WhatsApp Web listener${accountId ? ` (account: ${accountId})` : ""}. Start the gateway, then link WhatsApp with: openclaw channels login --channel whatsapp`,
      );
    }
    if (!listener.listGroups) {
      throw new Error("list-groups is not supported by the current WhatsApp Web listener.");
    }
    const groups = await listener.listGroups();
    return jsonResult({ groups });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
