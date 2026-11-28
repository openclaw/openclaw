import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../agents/tool-policy.js";

/**
 * Configured agent and provider tool policies for one Gateway caller. Both profile policies
 * also allow `alsoAllow`, after the profile's own additions.
 */
export function resolveGatewayConfiguredToolPolicies({
  alsoAllow,
  ...policyParams
}: Parameters<typeof resolveEffectiveToolPolicy>[0] & { alsoAllow: readonly string[] }) {
  const effective = resolveEffectiveToolPolicy(policyParams);
  const profilePolicy = resolveToolProfilePolicy(effective.profile);
  const providerProfilePolicy = resolveToolProfilePolicy(effective.providerProfile);
  return {
    ...effective,
    profilePolicy,
    providerProfilePolicy,
    profilePolicyWithAlsoAllow: mergeAlsoAllowPolicy(profilePolicy, [
      ...(effective.profileAlsoAllow ?? []),
      ...alsoAllow,
    ]),
    providerProfilePolicyWithAlsoAllow: mergeAlsoAllowPolicy(providerProfilePolicy, [
      ...(effective.providerProfileAlsoAllow ?? []),
      ...alsoAllow,
    ]),
  };
}
