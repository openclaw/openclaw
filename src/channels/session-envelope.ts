import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import type { OpenClawConfig } from "../config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";

export function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  return {
    storePath,
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
    previousTimestamp: readSessionUpdatedAt({
      storePath,
      sessionKey: params.sessionKey,
    }),
  };
}
