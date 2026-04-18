import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import {
  createInternalHookEvent,
  hasEnrichHooks,
  triggerEnrichHook,
  triggerInternalHook,
} from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessageEnrichContext,
  toInternalMessagePreprocessedContext,
  toInternalMessageTranscribedContext,
} from "../../hooks/message-hook-mappers.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { FinalizedMsgContext } from "../templating.js";

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
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "transcribed",
          sessionKey,
          toInternalMessageTranscribedContext(canonical, params.cfg),
        ),
      ),
      "get-reply: message:transcribed internal hook failed",
    );
  }

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

  if (!hasEnrichHooks()) {
    return;
  }

  try {
    const enrichedMetadata = await triggerEnrichHook(
      createInternalHookEvent(
        "message",
        "enrich",
        sessionKey,
        toInternalMessageEnrichContext(canonical),
      ),
    );
    const metadataKeys = Object.keys(enrichedMetadata);
    if (metadataKeys.length === 0) {
      return;
    }

    const enrichBlock = [
      "Enriched context (hook-injected metadata):",
      "```json",
      JSON.stringify(enrichedMetadata, null, 2),
      "```",
    ].join("\n");
    const untrustedContext = (params.ctx.UntrustedContext ??= []);
    untrustedContext.push(
      wrapExternalContent(enrichBlock, {
        source: "hook_metadata",
        includeWarning: false,
      }),
    );
    logVerbose(`get-reply: message:enrich injected ${metadataKeys.length} metadata key(s)`);
  } catch (err) {
    logVerbose(`get-reply: message:enrich internal hook failed: ${String(err)}`);
  }
}
