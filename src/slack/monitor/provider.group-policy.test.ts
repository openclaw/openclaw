import { describe } from "vitest";
import { installProviderRuntimeGroupPolicyFallbackSuite } from "../../test-utils/runtime-group-policy-contract.js";
import { __testing } from "./provider.js";

describe("resolveSlackRuntimeGroupPolicy", () => {
  installProviderRuntimeGroupPolicyFallbackSuite({
    resolve: __testing.resolveSlackRuntimeGroupPolicy,
    configuredLabel: "keeps open default when channels.slack is configured",
    defaultGroupPolicyUnderTest: "open",
    missingConfigLabel: "fails closed when channels.slack is missing and no defaults are set",
    missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
  });
});
