import type {
  GatewayAccessGrantRef,
  PluginGatewayAccessAuthority,
} from "../plugins/gateway-access-policy.types.js";

export type GatewayOperatorAccessAuthority = PluginGatewayAccessAuthority & {
  /** Unclassified callers and privileged effects always invoke the live plugin. */
  readonly assertCurrentForEffect?: () => void;
  /** Only explicitly classified non-effect checks may reuse a plugin-published allow. */
  readonly assertCurrentForRecheck?: () => void;
  /** Role requirement enforced when this authority was admitted. */
  readonly requiredPolicyPlugin?: string;
  readonly gatewayAccessGrant?: GatewayAccessGrantRef | null;
};
