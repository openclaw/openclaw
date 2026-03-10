import { describe, expect, it } from "vitest";
import { installProviderRuntimeGroupPolicyFallbackSuite } from "../../test-utils/runtime-group-policy-contract.js";
import { __testing } from "./provider.js";

describe("resolveDiscordRuntimeGroupPolicy", () => {
  installProviderRuntimeGroupPolicyFallbackSuite({
    resolve: __testing.resolveDiscordRuntimeGroupPolicy,
    configuredLabel: "keeps open default when channels.discord is configured",
    defaultGroupPolicyUnderTest: "open",
    missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
    missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
  });

  it("respects explicit provider policy", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
      groupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("disabled");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});
