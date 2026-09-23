import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayAccessGrantRef = Readonly<{ pluginId: string; grantId: string }>;

/** Additional access held by an authenticated person, independent of a transport. */
export type PluginGatewayAccessAuthority = Readonly<{
  /** Stable UUID for one uninterrupted grant, if the policy supports durable requests. */
  grantId?: string;
  assertCurrent: () => void;
  signal: AbortSignal;
}>;

type GatewayAccessPolicyContext = {
  config: OpenClawConfig;
  /** The person's effective operator role explicitly names this policy's plugin. */
  requiredByRole: boolean;
  profile: { profileId: string; emails: readonly string[]; assignedRole: string | null };
};

export type PluginGatewayAccessPolicy = {
  /** Return no authority when inapplicable; an explicit role binding still requires authority. */
  authorize: (context: GatewayAccessPolicyContext) => PluginGatewayAccessAuthority | undefined;
  /**
   * Check the original grant even if the current role is exempt. Return undefined
   * only for a definitively ended grant; throw while its state is unavailable.
   */
  resume?: (
    context: GatewayAccessPolicyContext & { grantId: string },
  ) => PluginGatewayAccessAuthority | undefined;
};
