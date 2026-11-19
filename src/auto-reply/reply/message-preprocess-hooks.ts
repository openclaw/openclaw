// Runs plugin message preprocessing hooks before reply prompt construction.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessagePreprocessedContext,
  toInternalMessageTranscribedContext,
} from "../../hooks/message-hook-mappers.js";
import type { FinalizedMsgContext } from "../templating.js";

export function emitPreAgentMessageHooks(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  isFastTestEnv: boolean;
}): void {
  if (params.isFastTestEnv) {
    return;
  }
  const sessionKey = normalizeOptionalString(params.ctx.SessionKey);
  if (!sessionKey) {
    return;
  }

  const canonical = deriveInboundMessageHookContext(params.ctx);
  for (const [action, mapContext] of [
    ["transcribed", toInternalMessageTranscribedContext],
    ["preprocessed", toInternalMessagePreprocessedContext],
  ] as const) {
    if (action === "transcribed" && !canonical.transcript) {
      continue;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent("message", action, sessionKey, mapContext(canonical, params.cfg)),
      ),
      `get-reply: message:${action} internal hook failed`,
    );
  }
}
