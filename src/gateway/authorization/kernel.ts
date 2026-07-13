import type { GatewayPrincipal } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  GatewayAuthorizationRuntime,
  GatewayAuthorizationContext,
  GatewayAgentSessionAuthorizationRef,
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
      security?: GatewayAuthorizationContext;
    }>
  | Readonly<{
      allowed: false;
      reason:
        | GatewayRbacDenialReason
        | "unauthenticated"
        | "unclassified-method"
        | "unscoped-domain";
    }>;

export async function authorizeGatewayAccess(_input: {
  runtime: GatewayAuthorizationRuntime;
  policy?: GatewayMethodAccessPolicy;
  principal?: GatewayPrincipal;
  domain?: IsolationDomainRef;
  delegation?: { id: string; assignmentId: string };
  agentSession?: GatewayAgentSessionAuthorizationRef;
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
  if (!_input.domain || !isNonEmptyString(_input.domain.id)) {
    return { allowed: false, reason: "unscoped-domain" };
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

  // Plugin policy objects are mutable JavaScript. Snapshot the exact proof before
  // awaiting the provider so the decision and request context cannot diverge.
  const permission = _input.policy.permission;
  const delegation = _input.delegation
    ? Object.freeze({
        id: _input.delegation.id,
        assignmentId: _input.delegation.assignmentId,
      })
    : undefined;
  if (
    delegation &&
    (!isNonEmptyString(delegation.id) || !isNonEmptyString(delegation.assignmentId))
  ) {
    return { allowed: false, reason: "indeterminate" };
  }
  const agentSession = _input.agentSession
    ? Object.freeze({
        id: _input.agentSession.id,
        invokingPrincipal: Object.freeze({
          issuer: _input.agentSession.invokingPrincipal.issuer,
          subject: _input.agentSession.invokingPrincipal.subject,
          kind: _input.agentSession.invokingPrincipal.kind,
        }),
      })
    : undefined;
  if (
    agentSession &&
    (!isNonEmptyString(agentSession.id) ||
      !isNonEmptyString(agentSession.invokingPrincipal.issuer) ||
      !isNonEmptyString(agentSession.invokingPrincipal.subject) ||
      agentSession.invokingPrincipal.kind !== "human")
  ) {
    return { allowed: false, reason: "indeterminate" };
  }
  const authorizedResources = Object.freeze(
    resources.map((resource) =>
      Object.freeze({
        namespace: resource.namespace,
        type: resource.type,
        id: resource.id,
      }),
    ),
  );

  try {
    const decision = await _input.runtime.authorize({
      principal: _input.principal,
      domain: _input.domain,
      ...(delegation ? { delegation } : {}),
      ...(agentSession ? { agentSession } : {}),
      method: _input.method,
      permission,
      resources: authorizedResources,
    });
    const allowed = (decision as { allowed?: unknown }).allowed;
    if (allowed === false) {
      const denied = decision as Extract<typeof decision, { allowed: false }>;
      return isGatewayRbacDenialReason(denied.reason)
        ? denied
        : { allowed: false, reason: "indeterminate" };
    }
    if (allowed !== true) {
      return { allowed: false, reason: "indeterminate" };
    }
    const allowedDecision = decision as Extract<typeof decision, { allowed: true }>;
    if (
      !isNonEmptyString(allowedDecision.principalId) ||
      !isNonEmptyString(allowedDecision.domain.id) ||
      allowedDecision.domain.id !== _input.domain.id
    ) {
      return { allowed: false, reason: "indeterminate" };
    }
    if (_input.principal.kind === "service") {
      if (
        !delegation ||
        !allowedDecision.delegation ||
        allowedDecision.delegation.id !== delegation.id ||
        allowedDecision.delegation.assignmentId !== delegation.assignmentId ||
        !isNonEmptyString(allowedDecision.delegation.sponsorPrincipalId)
      ) {
        return { allowed: false, reason: "indeterminate" };
      }
    } else if (allowedDecision.delegation) {
      return { allowed: false, reason: "indeterminate" };
    }
    return {
      allowed: true,
      security: Object.freeze({
        principalId: allowedDecision.principalId,
        principalKind: _input.principal.kind,
        domain: Object.freeze({ id: allowedDecision.domain.id }),
        method: _input.method,
        permission,
        resources: authorizedResources,
        ...(allowedDecision.delegation
          ? { delegation: Object.freeze({ ...allowedDecision.delegation }) }
          : {}),
      }),
    };
  } catch {
    return { allowed: false, reason: "indeterminate" };
  }
}
