import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessagePreprocessedContext,
  toInternalMessageTranscribedContext,
} from "../../hooks/message-hook-mappers.js";
import type { FinalizedMsgContext } from "../templating.js";

export async function emitPreAgentMessageHooks(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  isFastTestEnv: boolean;
}): Promise<void> {
  if (params.isFastTestEnv) {
    return;
  }
  const sessionKey = params.ctx.SessionKey?.trim();
  if (!sessionKey) {
    return;
  }

  const canonical = deriveInboundMessageHookContext(params.ctx);
  if (canonical.transcript) {
    // Await the transcribed hook so transcript-echo (and any other
    // message:transcribed handlers) complete before the agent starts
    // replying. This ensures the echo appears in chat before our response.
    try {
      await triggerInternalHook(
        createInternalHookEvent(
          "message",
          "transcribed",
          sessionKey,
          toInternalMessageTranscribedContext(canonical, params.cfg),
        ),
      );
    } catch (err) {
      logVerbose(`get-reply: message:transcribed internal hook failed: ${String(err)}`);
    }
  }

  // preprocessed hook remains fire-and-forget — nothing downstream depends
  // on it completing before agent execution begins.
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "preprocessed",
        sessionKey,
        toInternalMessagePreprocessedContext(canonical, params.cfg),
      ),
    ),
    "get-reply: message:preprocessed internal hook failed",
  );
}
