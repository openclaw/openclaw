import type { GroupPolicy } from "./types.base.js";
import { resolveRuntimeGroupPolicy } from "./runtime-group-policy.js";

export function resolveProviderRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
} {
  return resolveRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
    configuredFallbackPolicy: "open",
    missingProviderFallbackPolicy: "allowlist",
  });
}
