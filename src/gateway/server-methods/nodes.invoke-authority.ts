import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { captureSessionEventTargetForHost } from "../../auto-reply/reply/session-event-handoff.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
} from "../../infra/event-session-routing.js";
import type { NodeSystemRunEventSource } from "../node-invoke.types.js";
import { captureGatewayOperatorContinuation } from "../operator-run-recovery.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Capture the original caller before the node connection becomes the event producer. */
export async function captureNodeSystemRunEventSource(
  input: Pick<GatewayRequestHandlerOptions, "client" | "context" | "hasCurrentClientAuthority">,
  sessionKey: string,
): Promise<NodeSystemRunEventSource | undefined> {
  const cfg = input.context.getRuntimeConfig();
  const { canonicalKey, agentId } = resolveSessionStoreIdentity({ cfg, sessionKey });
  const captured = await captureGatewayOperatorContinuation({ ...input, agentId });
  if (!captured && !getGatewayToolCallerIdentity()) {
    return undefined;
  }
  try {
    const destination = resolveEventSessionKeyForPolicy(
      canonicalKey,
      resolveEventSessionRoutingPolicy({ cfg, sessionKey: canonicalKey }),
    );
    const expectedTarget = await captureSessionEventTargetForHost(agentId, destination, {
      operatorAuthority: captured?.authority,
      retainRequesterOwner: true,
    });
    return { expectedTarget, release: captured?.release ?? (() => {}) };
  } catch (error) {
    captured?.release();
    throw error;
  }
}
