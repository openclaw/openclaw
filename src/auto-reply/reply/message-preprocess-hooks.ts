import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessagePreprocessedContext,
  toInternalMessageTranscribedContext,
} from "../../hooks/message-hook-mappers.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { FinalizedMsgContext } from "../templating.js";

function applyPreprocessedContextMutations(
  ctx: FinalizedMsgContext,
  context: Record<string, unknown>,
): void {
  if (typeof context.body === "string") {
    ctx.Body = context.body;
  }
  if (typeof context.bodyForAgent === "string") {
    ctx.BodyForAgent = context.bodyForAgent;
  }
  if (typeof context.transcript === "string") {
    ctx.Transcript = context.transcript;
  }
}

export async function emitPreAgentMessageHooks(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  isFastTestEnv: boolean;
}): Promise<void> {
  if (params.isFastTestEnv) {
    return;
  }
  const sessionKey = normalizeOptionalString(params.ctx.SessionKey);
  if (!sessionKey) {
    return;
  }

  const canonical = deriveInboundMessageHookContext(params.ctx);
  if (canonical.transcript) {
    await triggerInternalHook(
      createInternalHookEvent(
        "message",
        "transcribed",
        sessionKey,
        toInternalMessageTranscribedContext(canonical, params.cfg),
      ),
    );
  }

  const preprocessedEvent = createInternalHookEvent(
    "message",
    "preprocessed",
    sessionKey,
    toInternalMessagePreprocessedContext(canonical, params.cfg),
  );
  await triggerInternalHook(preprocessedEvent);
  applyPreprocessedContextMutations(params.ctx, preprocessedEvent.context);
}
