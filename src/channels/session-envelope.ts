import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { readSessionUpdatedAt } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  return {
    agentId: params.agentId,
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
    previousTimestamp: readSessionUpdatedAt({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
  };
}
