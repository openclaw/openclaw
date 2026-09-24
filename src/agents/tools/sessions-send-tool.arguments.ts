import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { readToolStringParam } from "./common.js";

const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;

export function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params = isRecord(args) ? { ...args } : {};

  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readToolStringParam(params, alias, { trim: false });
      if (value?.trim()) {
        params.message = stripFormattedReasoningMessage(value);
        break;
      }
    }
  }

  for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
    delete params[alias];
  }
  return params;
}
