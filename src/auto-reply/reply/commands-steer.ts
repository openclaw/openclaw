// Implements explicit steering through the durable prepared-reply queue path.
import { logVerbose } from "../../globals.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import {
  parseSteerMessage,
  resolveActiveExplicitSteerSessionKey,
} from "./explicit-steer-routing.js";

const STEER_USAGE = "Usage: /steer <message>";

export const handleSteerCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/steer", match: parseSteerMessage },
  async (params, message) => {
    if (!message) {
      return commandReply(STEER_USAGE);
    }

    const steerTargetSessionKey = resolveActiveExplicitSteerSessionKey({
      cfg: params.cfg,
      ctx: params.ctx,
      sessionKey: params.sessionKey,
      commandBody: params.command.commandBodyNormalized,
    });
    if (!steerTargetSessionKey) {
      logVerbose("steer: no active run; continuing with /steer payload as a normal prompt");
      applyCommandTextToParams(params, message);
      return { shouldContinue: true };
    }
    // Session routing resolves the active :direct:/:dm: alias before session
    // preparation. From here the ordinary prepared reply path owns media,
    // transcript persistence, stable queue identity, cancellation, lifecycle
    // adoption, and fallback if the active run disappears before admission.
    applyCommandTextToParams(params, message);
    return { shouldContinue: true, queueModeOverride: "steer" };
  },
);
