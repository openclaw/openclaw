/** Fallback command-turn detection for mixed native/text channel metadata. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isControlCommandMessage } from "./command-detection.js";
import {
  isExplicitCommandTurn,
  resolveCommandBody,
  resolveCommandTurnContext,
  type CommandTurnContextInput,
} from "./command-turn-context.js";

function resolveStructuredNormalFallbackBody(input: CommandTurnContextInput): string | undefined {
  const visibleBody =
    typeof input.rawText === "string"
      ? input.rawText
      : (normalizeOptionalString(input.RawBody) ?? normalizeOptionalString(input.Body));
  if (!/^[!/]/.test(visibleBody ?? "")) {
    return undefined;
  }
  // Structured normal turns may carry a command-only body hidden from the visible message text.
  return resolveCommandBody(input) ?? visibleBody;
}

/** Returns true when inbound metadata or command text identifies an explicit command turn. */
export function isExplicitCommandTurnContext(
  input: CommandTurnContextInput,
  cfg: OpenClawConfig,
): boolean {
  if (isExplicitCommandTurn(resolveCommandTurnContext(input))) {
    return true;
  }
  if (input.CommandSource === "native" || input.CommandSource === "text") {
    return false;
  }
  const fallbackBody =
    input.CommandTurn !== undefined || input.CommandSource === "message"
      ? resolveStructuredNormalFallbackBody(input)
      : resolveCommandBody(input);
  return (
    input.CommandAuthorized === true &&
    isControlCommandMessage(fallbackBody, cfg, {
      botUsername: normalizeOptionalString(input.BotUsername),
    })
  );
}
