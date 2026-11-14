import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Compute the shared effective policy from the current runtime identity and config. */
export function resolveGatewayConfiguredToolPolicies(params: {
  config: OpenClawConfig;
  runtimePolicySessionKey: string;
  runtimePolicyAgentId: string;
  modelProvider?: string;
  modelId?: string;
  gatewayRequestedTools: string[];
  runtimeAlsoAllow: string[];
}) {
  const effective = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.runtimePolicySessionKey,
    agentId: params.runtimePolicyAgentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profilePolicy = resolveToolProfilePolicy(effective.profile);
  const providerProfilePolicy = resolveToolProfilePolicy(effective.providerProfile);
  return {
    ...effective,
    profilePolicy,
    providerProfilePolicy,
    profilePolicyWithAlsoAllow: mergeAlsoAllowPolicy(profilePolicy, [
      ...(effective.profileAlsoAllow ?? []),
      ...params.gatewayRequestedTools,
      ...params.runtimeAlsoAllow,
    ]),
    providerProfilePolicyWithAlsoAllow: mergeAlsoAllowPolicy(providerProfilePolicy, [
      ...(effective.providerProfileAlsoAllow ?? []),
      ...params.gatewayRequestedTools,
      ...params.runtimeAlsoAllow,
    ]),
  };
}
