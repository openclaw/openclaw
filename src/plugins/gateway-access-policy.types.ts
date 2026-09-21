import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Additional access held by an authenticated person, independent of a transport. */
export type PluginGatewayAccessAuthority = Readonly<{
  assertCurrent: () => void;
  signal: AbortSignal;
}>;

export type PluginGatewayAccessPolicy = {
  /** Return no authority when inapplicable; an explicit role binding still requires authority. */
  authorize: (context: {
    config: OpenClawConfig;
    profile: { profileId: string; emails: readonly string[]; assignedRole: string | null };
    /** The person's effective operator role explicitly names this policy's plugin. */
    requiredByRole: boolean;
  }) => PluginGatewayAccessAuthority | undefined;
};
