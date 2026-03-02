import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { sendReactionWhatsApp } from "../../web/outbound.js";
import { createActionGate, jsonResult, readReactionParams, readStringParam } from "./common.js";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./whatsapp-target-auth.js";

function resolveWhatsAppReactionMessageId(params: Record<string, unknown>): string {
  const explicitMessageId =
    readStringParam(params, "messageId") ?? readStringParam(params, "message_id");
  if (explicitMessageId) {
    return explicitMessageId;
  }
  const contextFallbackMessageId =
    readStringParam(params, "CurrentMessageId") ??
    readStringParam(params, "MessageSidFull") ??
    readStringParam(params, "MessageSid") ??
    readStringParam(params, "MessageSidFirst") ??
    readStringParam(params, "MessageSidLast");
  if (contextFallbackMessageId) {
    return contextFallbackMessageId;
  }
  throw new Error("messageId required");
}

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
    const messageId = resolveWhatsAppReactionMessageId(params);
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const accountId = readStringParam(params, "accountId");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;

    // Resolve account + allowFrom via shared account logic so auth and routing stay aligned.
    const resolved = resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: "reaction",
    });

    const resolvedEmoji = remove ? "" : emoji;
    await sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: resolved.accountId,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
