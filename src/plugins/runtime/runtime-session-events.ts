import type { SessionEventTarget as HostTarget } from "../../auto-reply/reply/session-event-contract.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../../auto-reply/reply/session-event-handoff.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

declare const capturedTarget: unique symbol;
type SessionEventTarget = { readonly [capturedTarget]: true };

// Source and built runtime copies redeem the same opaque handles.
const targets = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSessionEventTargets"),
  () => new WeakMap<SessionEventTarget, HostTarget>(),
);

/** Capture the original destination before asynchronous plugin work. */
export async function captureSessionEventTarget(
  agentId: string,
  sessionKey: string,
): Promise<SessionEventTarget> {
  const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertSystemOwnerCurrent;
  assertCurrent?.();
  const target = await captureSessionEventTargetForHost(agentId, sessionKey, { assertCurrent });
  assertCurrent?.();
  // SAFETY: This mint registers the fresh handle in the private WeakMap; redemption rejects copies and validates the host-captured target.
  const handle = Object.freeze({}) as SessionEventTarget;
  targets.set(handle, target);
  return handle;
}

/** Admit a bounded internal follow-up through the destination's normal session queue. */
export function enqueueSessionEvent(
  text: string,
  options: {
    agentId: string;
    sessionKey: string;
    contextKey?: string;
    deliveryContext?: DeliveryContext;
    abortSignal?: AbortSignal;
    expectedTarget?: SessionEventTarget;
    /** Explicit fresh ingress may initialize an absent session after authorization. */
    createIfMissing?: true;
  },
) {
  const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertSystemOwnerCurrent;
  assertCurrent?.();
  const expectedTarget = options.expectedTarget ? targets.get(options.expectedTarget) : undefined;
  if (options.expectedTarget && !expectedTarget) {
    throw new Error(
      "Session event target was not captured by this runtime; capture it before asynchronous work",
    );
  }
  return enqueueSessionEventForHost(text, {
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    source: "plugin",
    contextKey: options.contextKey,
    deliveryContext: options.deliveryContext,
    abortSignal: options.abortSignal,
    expectedTarget,
    createIfMissing: options.createIfMissing,
    ...(assertCurrent ? { assertCurrent } : {}),
  });
}
