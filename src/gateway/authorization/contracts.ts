import type { GatewayPrincipal } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type IsolationDomainRef = Readonly<{ id: string }>;

export type GatewayAuthorizationContext = Readonly<{
  principalId: string;
  domain: IsolationDomainRef;
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
      permission: string;
      resolveResources: (
        input: GatewayResourceResolutionInput,
      ) => Promise<readonly GatewayResourceRef[]> | readonly GatewayResourceRef[];
    }>;

export type GatewayAuthorizationRequest = Readonly<{
  principal: GatewayPrincipal;
  domain: IsolationDomainRef;
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
