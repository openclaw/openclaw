import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

/** A host-issued, one-dispatch claim. It is never part of an RPC payload or plugin context. */
export type AcceptedPluginGatewayHandoffClaim = {
  pluginId: string;
  toolName: string;
  method: string;
  params: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  operatorAuthority: AdmittedRunOperatorAuthority;
  signal: AbortSignal;
  assertCurrent(): void;
};

const claims = new AsyncLocalStorage<{
  claim: AcceptedPluginGatewayHandoffClaim;
  consumed: boolean;
}>();

/** Enter only around the one host-owned post-yield Gateway request. */
export function withAcceptedPluginGatewayHandoffClaim<T>(
  claim: AcceptedPluginGatewayHandoffClaim,
  run: () => T,
): T {
  claim.assertCurrent();
  return claims.run({ claim, consumed: false }, run);
}

/** Consume before any await so a sibling or nested RPC cannot reuse this admission. */
export function consumeAcceptedPluginGatewayHandoffClaim(
  options: GatewayRequestHandlerOptions,
  expected: { pluginId: string; toolName: string },
): AcceptedPluginGatewayHandoffClaim {
  const state = claims.getStore();
  const claim = state?.claim;
  const dispatchedAuthority = options.client?.internal?.operatorRunAuthority;
  if (
    !state ||
    state.consumed ||
    !claim ||
    claim.pluginId !== expected.pluginId ||
    claim.toolName !== expected.toolName ||
    claim.method !== options.req.method ||
    !isDeepStrictEqual(claim.params, options.params) ||
    !dispatchedAuthority ||
    !claim.operatorAuthority.source ||
    dispatchedAuthority.source !== claim.operatorAuthority.source ||
    dispatchedAuthority.profileId !== claim.operatorAuthority.profileId ||
    options.client?.internal?.syntheticClient !== true
  ) {
    throw new Error("This Gateway request has no accepted plugin tool handoff.");
  }
  state.consumed = true;
  claim.assertCurrent();
  claim.operatorAuthority.assertCurrent();
  dispatchedAuthority.assertCurrent();
  return claim;
}
