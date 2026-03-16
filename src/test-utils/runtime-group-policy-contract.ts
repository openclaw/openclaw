import { expect, it } from "vitest";
import type {
  ResolveProviderRuntimeGroupPolicyParams,
  RuntimeGroupPolicyResolution,
} from "../config/runtime-group-policy.js";
import type { GroupPolicy } from "../config/types.base.js";

type RuntimeGroupPolicyResolver = (
  params: ResolveProviderRuntimeGroupPolicyParams,
) => RuntimeGroupPolicyResolution;

export function installProviderRuntimeGroupPolicyFallbackSuite(params: {
  configuredLabel: string;
  defaultGroupPolicyUnderTest: GroupPolicy;
  missingConfigLabel: string;
  missingDefaultLabel: string;
  resolve: RuntimeGroupPolicyResolver;
}) {
  it(params.missingConfigLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it(params.configuredLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it(params.missingDefaultLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
      defaultGroupPolicy: params.defaultGroupPolicyUnderTest,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
}
