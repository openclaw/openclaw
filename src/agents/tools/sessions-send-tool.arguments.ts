import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { ToolInputError } from "../tool-input-error.js";
import { readNonNegativeIntegerParam, readToolStringParam } from "./common.js";

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

/** Parse the operation once; identity-based resume admission remains with the send owner. */
export function parseSessionsSendOperation(args: unknown): {
  params: Record<string, unknown>;
  message: string;
  mode: "notify" | "steer" | "followup" | "resume" | undefined;
  timeoutSeconds: number;
} {
  const params = normalizeSessionsSendArguments(args);
  const message = readToolStringParam(params, "message", { required: true, trim: false });
  if (!message.trim()) {
    throw new ToolInputError("message required");
  }
  const mode = readToolStringParam(params, "mode");
  if (
    mode !== undefined &&
    mode !== "notify" &&
    mode !== "steer" &&
    mode !== "followup" &&
    mode !== "resume"
  ) {
    throw new ToolInputError("mode must be notify, steer, followup, or resume");
  }
  if (
    mode === "resume" &&
    (params.watch === true || (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 0) > 0)
  ) {
    throw new ToolInputError(
      "mode=resume returns admission only; omit watch and timeoutSeconds or set timeoutSeconds=0. The task owner delivers completion.",
    );
  }
  const timeoutSeconds =
    mode === "steer" || mode === "resume"
      ? 0
      : (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30);
  return { params, message, mode, timeoutSeconds };
}
