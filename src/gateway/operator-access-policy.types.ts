import type {
  GatewayAccessGrantRef,
  PluginGatewayAccessAuthority,
} from "../plugins/gateway-access-policy.types.js";

export type GatewayOperatorAccessAuthority = PluginGatewayAccessAuthority & {
  readonly gatewayAccessGrant?: GatewayAccessGrantRef;
};
