import type { GatewayPrincipal } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type IsolationDomainRef = Readonly<{ id: string }>;

export type GatewayDelegationRef = Readonly<{
  id: string;
  assignmentId: string;
}>;

export type GatewayValidatedDelegation = GatewayDelegationRef &
  Readonly<{ sponsorPrincipalId: string }>;

export const GATEWAY_AGENT_SESSION_INVOKE_PERMISSION = "agents.session.invoke";

/** Server-only proof binding one agent run to its authenticated human invoker. */
export type GatewayAgentSessionAuthorizationRef = Readonly<{
  id: string;
  invokingPrincipal: GatewayPrincipal;
}>;

/** Immutable server-issued subject carried into one agent run; never derived from tool arguments. */
export type GatewayAuthorizationSubject = Readonly<{
  principal: GatewayPrincipal;
  domain: IsolationDomainRef;
  delegation?: GatewayDelegationRef;
  agentSession?: GatewayAgentSessionAuthorizationRef;
}>;

export type GatewayAuthorizationContext = Readonly<{
  principalId: string;
  principalKind: GatewayPrincipal["kind"];
  domain: IsolationDomainRef;
  method: string;
  permission: string;
  resources: readonly GatewayResourceRef[];
  pluginId?: string;
  requestId?: string;
  delegation?: GatewayValidatedDelegation;
}>;

export type GatewayResourceRef = Readonly<{
  namespace: string;
  type: string;
  id: string;
}>;

export type GatewayResourceResolutionInput = Readonly<{
  method: string;
  params: unknown;
  config: OpenClawConfig;
}>;

export type GatewayMethodAccessPolicy =
  | Readonly<{ kind: "public" }>
  | Readonly<{
      kind: "resource";
      /** Explicit plugin opt-in for scope-less Teams member sessions. */
      member?: boolean;
      permission: string;
      resolveResources: (
        input: GatewayResourceResolutionInput,
      ) => Promise<readonly GatewayResourceRef[]> | readonly GatewayResourceRef[];
    }>;

export type GatewayAuthorizationRequest = Readonly<{
  principal: GatewayPrincipal;
  domain: IsolationDomainRef;
  delegation?: GatewayDelegationRef;
  agentSession?: GatewayAgentSessionAuthorizationRef;
  method: string;
  permission: string;
  resources: readonly GatewayResourceRef[];
}>;

export type GatewayRbacDenialReason =
  | "unknown-principal"
  | "unbound-resource"
  | "cross-domain"
  | "forbidden"
  | "indeterminate";

export type GatewayRbacDecision =
  | Readonly<{
      allowed: true;
      principalId: string;
      domain: IsolationDomainRef;
      delegation?: GatewayValidatedDelegation;
    }>
  | Readonly<{
      allowed: false;
      reason: GatewayRbacDenialReason;
    }>;

export type GatewayAuthorizationRuntime =
  | Readonly<{ mode: "legacy" }>
  | Readonly<{
      mode: "isolated";
      authorize: (request: GatewayAuthorizationRequest) => Promise<GatewayRbacDecision>;
    }>;
