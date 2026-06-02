import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

function loadInboundSessionRuntime() {
  // Session metadata writes are best-effort on hot channel paths; keep the runtime import lazy
  // and process-local so plugins do not pay the session-store cost until they record metadata.
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

/** Records inbound session metadata while converting store failures into an optional callback. */
export async function recordInboundSessionMetaSafe(params: {
  /** OpenClaw config used to resolve the session store location. */
  cfg: OpenClawConfig;
  /** Agent whose session store should receive the inbound metadata. */
  agentId: string;
  /** Stable session key for the channel conversation. */
  sessionKey: string;
  /** Message context projected into the session metadata store. */
  ctx: MsgContext;
  /** Optional observer for best-effort write failures. */
  onError?: (error: unknown) => void;
}): Promise<void> {
  const runtime = await loadInboundSessionRuntime();
  const storePath = runtime.resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  try {
    await runtime.recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.sessionKey,
      ctx: params.ctx,
    });
  } catch (err) {
    params.onError?.(err);
  }
}
