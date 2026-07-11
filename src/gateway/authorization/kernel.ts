import type { GatewayPrincipal } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  GatewayAuthorizationRuntime,
  GatewayMethodAccessPolicy,
  GatewayRbacDenialReason,
  IsolationDomainRef,
} from "./contracts.js";

const GATEWAY_RBAC_DENIAL_REASONS = new Set<GatewayRbacDenialReason>([
  "unknown-principal",
  "unbound-resource",
  "cross-domain",
  "forbidden",
  "indeterminate",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isGatewayRbacDenialReason(value: unknown): value is GatewayRbacDenialReason {
  return (
    typeof value === "string" && GATEWAY_RBAC_DENIAL_REASONS.has(value as GatewayRbacDenialReason)
  );
}

export type GatewayAuthorizationOutcome =
  | Readonly<{
      allowed: true;
      security?: Readonly<{ principalId: string; domain: IsolationDomainRef }>;
    }>
  | Readonly<{
      allowed: false;
      reason: GatewayRbacDenialReason | "unauthenticated" | "unclassified-method";
    }>;

export async function authorizeGatewayAccess(_input: {
  runtime: GatewayAuthorizationRuntime;
  policy?: GatewayMethodAccessPolicy;
  principal?: GatewayPrincipal;
  method: string;
  params: unknown;
  getConfig: () => OpenClawConfig;
}): Promise<GatewayAuthorizationOutcome> {
  if (_input.runtime.mode === "legacy") {
    return { allowed: true };
  }
  if (_input.runtime.mode !== "isolated") {
    return { allowed: false, reason: "indeterminate" };
  }
  if (_input.policy?.kind === "public") {
    return { allowed: true };
  }
  if (!_input.policy) {
    return { allowed: false, reason: "unclassified-method" };
  }
  if (!_input.principal) {
    return { allowed: false, reason: "unauthenticated" };
  }

  let resources;
  try {
    resources = await _input.policy.resolveResources({
      method: _input.method,
      params: _input.params,
      config: _input.getConfig(),
    });
  } catch {
    return { allowed: false, reason: "indeterminate" };
  }
  if (
    !Array.isArray(resources) ||
    resources.length === 0 ||
    resources.some(
      (resource) =>
        !resource ||
        !isNonEmptyString(resource.namespace) ||
        !isNonEmptyString(resource.type) ||
        !isNonEmptyString(resource.id),
    )
  ) {
    return { allowed: false, reason: "unbound-resource" };
  }

  try {
    const decision = await _input.runtime.authorize({
      principal: _input.principal,
      method: _input.method,
      permission: _input.policy.permission,
      resources,
    });
    if (decision.allowed === false) {
      return isGatewayRbacDenialReason(decision.reason)
        ? decision
        : { allowed: false, reason: "indeterminate" };
    }
    if (decision.allowed !== true) {
      return { allowed: false, reason: "indeterminate" };
    }
    if (!isNonEmptyString(decision.principalId) || !isNonEmptyString(decision.domain.id)) {
      return { allowed: false, reason: "indeterminate" };
    }
    return {
      allowed: true,
      security: { principalId: decision.principalId, domain: decision.domain },
    };
  } catch {
    return { allowed: false, reason: "indeterminate" };
  }
}
