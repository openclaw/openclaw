import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

function loadInboundSessionRuntime() {
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

export async function recordInboundSessionMetaSafe(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  ctx: MsgContext;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const runtime = await loadInboundSessionRuntime();
  try {
    await runtime.recordSessionMetaFromInbound({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      ctx: params.ctx,
    });
  } catch (err) {
    params.onError?.(err);
  }
}
