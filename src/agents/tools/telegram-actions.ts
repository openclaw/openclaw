import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ClawdbotConfig } from "../../config/config.js";
import { reactMessageTelegram } from "../../telegram/send.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringOrNumberParam,
  readStringParam,
} from "./common.js";

export async function handleTelegramAction(
  params: Record<string, unknown>,
  cfg: ClawdbotConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled = createActionGate(cfg.telegram?.actions);

  if (action === "react") {
    if (!isActionEnabled("reactions")) {
      throw new Error("Telegram reactions are disabled.");
    }
    const chatId = readStringOrNumberParam(params, "chatId", {
      required: true,
    });
    const messageId = readNumberParam(params, "messageId", {
      required: true,
      integer: true,
    });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a Telegram reaction.",
    });
    const token = resolveTelegramToken(cfg).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or telegram.botToken.",
      );
    }
    await reactMessageTelegram(chatId ?? "", messageId ?? 0, emoji ?? "", {
      token,
      remove,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  throw new Error(`Unsupported Telegram action: ${action}`);
}
