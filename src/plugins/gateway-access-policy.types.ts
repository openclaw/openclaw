import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayAccessGrantRef = Readonly<{ pluginId: string; grantId: string }>;

/** Additional access held by an authenticated person, independent of a transport. */
export type PluginGatewayAccessAuthority = Readonly<{
  /** Stable UUID for one uninterrupted grant, if the policy supports durable requests. */
  grantId?: string;
  assertCurrent: () => void;
  /**
   * Exclusive Unix-ms bound for a successful recheck; Infinity explicitly means
   * no time bound. Omit when unknown. Read after each successful live assertion.
   */
  recheckValidUntil?: number;
  signal: AbortSignal;
}>;

type GatewayAccessPolicyContext = {
  config: OpenClawConfig;
  /** The person's effective operator role explicitly names this policy's plugin. */
  requiredByRole: boolean;
  profile: {
    profileId: string;
    emails: readonly string[];
    githubAccountIds?: readonly number[];
    assignedRole: string | null;
  };
};

export type PluginGatewayAccessPolicy = {
  /**
   * Opt into non-effect recheck caching. Publish the initial revision synchronously
   * and a fresh revision before any dependency can change an assertion's answer.
   * Publish undefined while uncertain, including unavailable external inputs.
   * Assertions must depend only on captured inputs, revision, validity and signal,
   * never mutable ambient invocation state. Otherwise omit this subscription.
   * The returned unsubscribe runs when this plugin instance retires.
   */
  subscribeRevision?: (publish: (revision: string | undefined) => void) => () => void;
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
