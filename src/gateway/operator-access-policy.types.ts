import type {
  GatewayAccessGrantRef,
  PluginGatewayAccessAuthority,
} from "../plugins/gateway-access-policy.types.js";

export type GatewayOperatorAccessAuthority = PluginGatewayAccessAuthority & {
  /** Role requirement enforced when this authority was admitted. */
  readonly requiredPolicyPlugin?: string;
  readonly gatewayAccessGrant?: GatewayAccessGrantRef | null;
};
