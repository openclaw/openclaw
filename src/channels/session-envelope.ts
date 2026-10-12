// Session-envelope context resolver for inbound channel turns.
import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { readSessionUpdatedAtCore } from "../config/sessions/session-accessor.js";
import { readSessionUpdatedAtInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** @deprecated Use resolveInboundSessionEnvelopeContextAsync. Retained until the next Plugin SDK major. */
export function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  return {
    storePath,
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
    previousTimestamp: readSessionUpdatedAtCore({
      storePath,
      sessionKey: params.sessionKey,
    }),
  };
}

/** Prepares descriptive session facts before building an inbound envelope. */
export async function resolveInboundSessionEnvelopeContextAsync(
  params: Parameters<typeof resolveInboundSessionEnvelopeContext>[0],
) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
  const previousTimestamp = await readSessionUpdatedAtInWorker({
    storePath,
    sessionKey: params.sessionKey,
  });
  return { storePath, envelopeOptions, previousTimestamp };
}
