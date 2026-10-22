import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  hasGatewayContextOwner,
} from "../plugins/runtime/gateway-request-scope.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.types.js";
import type { SessionRuntimeScope } from "./server-methods/shared-types.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
export type { SessionRuntimeScope } from "./server-methods/shared-types.js";

/** Capture the Gateway binding, not the mutable context returned by its resolver. */
export function captureGatewayScopeMatcher(
  resolver: GatewayContextResolver | undefined,
): (owner: object) => boolean {
  const gatewayOwner = resolver && getCanonicalGatewayContextResolver(resolver);
  return (owner) =>
    resolver
      ? Boolean(gatewayOwner && hasGatewayContextOwner(owner, gatewayOwner))
      : getGatewayContextResolver(owner) === undefined;
}

/** Admission retains locators; the prepared row owner resolves their physical stores. */
export function captureSessionStoreScopeMatcher(scope: SessionRuntimeScope) {
  const selected = scope.physicalPaths?.(scope.storePath) ?? [scope.storePath];
  return (storePath: string, agentId?: string) =>
    (scope.physicalPaths?.(storePath, agentId) ?? [storePath]).some((path) =>
      selected.includes(path),
    );
}

export function captureRpcSourceScopeMatcher(scope: SessionRuntimeScope) {
  const matchesGateway = captureGatewayScopeMatcher(scope.resolveGatewayContext);
  const matchesStore = captureSessionStoreScopeMatcher(scope);
  return (ref: RpcSourceRef) =>
    ref.input.target !== undefined &&
    matchesStore(ref.input.target.storeScope, ref.input.target.agentId) &&
    matchesGateway(ref.input);
}
