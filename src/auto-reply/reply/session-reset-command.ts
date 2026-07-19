// Resolves configured hard reset triggers into one canonical command shape.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { DEFAULT_RESET_TRIGGERS } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeCommandBody } from "../commands-registry.js";
import type { MsgContext } from "../templating.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

export type HardSessionResetRequest = Readonly<{
  action: "new" | "reset";
  bodyStripped: string;
  matchedTriggerLower: string;
}>;

export type SessionResetCommandResolution = Readonly<{
  hardReset?: HardSessionResetRequest;
  isGroup: boolean;
  normalizedResetBody: string;
  softReset: ReturnType<typeof parseSoftResetCommand>;
  triggerBodyNormalized: string;
}>;

/** Keeps preflight authorization and the locked session mutation on identical trigger parsing. */
export function resolveSessionResetCommand(params: {
  agentId: string;
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): SessionResetCommandResolution {
  const commandSource =
    params.ctx.BodyForCommands ??
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    params.ctx.Body ??
    "";
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();
  const normalizedChatType = normalizeChatType(params.ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct"
      ? true
      : Boolean(resolveGroupSessionKey(params.ctx));
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, params.ctx, params.cfg, params.agentId)
    : triggerBodyNormalized;
  const normalizedResetBody = normalizeCommandBody(strippedForReset, {
    botUsername: params.ctx.BotUsername,
  });
  const softReset = parseSoftResetCommand(normalizedResetBody);
  const trimmedBodyLower = normalizeLowercaseStringOrEmpty(commandSource.trim());
  const strippedForResetLower = normalizeLowercaseStringOrEmpty(normalizedResetBody);
  const resetTriggers = params.cfg.session?.resetTriggers?.length
    ? params.cfg.session.resetTriggers
    : DEFAULT_RESET_TRIGGERS;

  let hardReset: HardSessionResetRequest | undefined;
  for (const trigger of resetTriggers) {
    if (!trigger) {
      continue;
    }
    const triggerLower = normalizeLowercaseStringOrEmpty(trigger);
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      hardReset = Object.freeze({
        action: triggerLower === "/reset" ? "reset" : "new",
        bodyStripped: "",
        matchedTriggerLower: triggerLower,
      });
      break;
    }
    const triggerPrefixLower = `${triggerLower} `;
    if (
      !softReset.matched &&
      (trimmedBodyLower.startsWith(triggerPrefixLower) ||
        strippedForResetLower.startsWith(triggerPrefixLower))
    ) {
      hardReset = Object.freeze({
        action: triggerLower === "/reset" ? "reset" : "new",
        bodyStripped: normalizedResetBody.slice(trigger.length).trimStart(),
        matchedTriggerLower: triggerLower,
      });
      break;
    }
  }

  return Object.freeze({
    ...(hardReset ? { hardReset } : {}),
    isGroup,
    normalizedResetBody,
    softReset,
    triggerBodyNormalized,
  });
}
