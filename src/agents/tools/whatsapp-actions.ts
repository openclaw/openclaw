import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type {
  ClawdbotConfig,
  WhatsAppActionConfig,
} from "../../config/config.js";
import { isSelfChatMode } from "../../utils.js";
import { sendReactionWhatsApp } from "../../web/outbound.js";
import { readWebSelfId } from "../../web/session.js";
import { jsonResult, readStringParam } from "./common.js";

type ActionGate = (
  key: keyof WhatsAppActionConfig,
  defaultValue?: boolean,
) => boolean;

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: ClawdbotConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled: ActionGate = (key, defaultValue = true) => {
    const value = cfg.whatsapp?.actions?.[key];
    if (value === undefined) return defaultValue;
    return value !== false;
  };

  if (action === "react") {
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const emoji = readStringParam(params, "emoji", { required: true });
    const participant = readStringParam(params, "participant");
    const selfE164 = readWebSelfId().e164;
    const fromMe = isSelfChatMode(selfE164, cfg.whatsapp?.allowFrom);
    await sendReactionWhatsApp(chatJid, messageId, emoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
    });
    return jsonResult({ ok: true });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
