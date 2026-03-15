import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { recordSessionMetaFromInbound, resolveStorePath } from "../config/sessions.js";

export async function recordInboundSessionMetaSafe(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  ctx: MsgContext;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  try {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.sessionKey,
      ctx: params.ctx,
    });
  } catch (err) {
    params.onError?.(err);
  }
}
