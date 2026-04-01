import { describe } from "vitest";
import { installProviderRuntimeGroupPolicyFallbackSuite } from "../../test-utils/runtime-group-policy-contract.js";
import { __testing } from "./monitor-provider.js";

describe("resolveIMessageRuntimeGroupPolicy", () => {
  installProviderRuntimeGroupPolicyFallbackSuite({
    resolve: __testing.resolveIMessageRuntimeGroupPolicy,
    configuredLabel: "keeps open fallback when channels.imessage is configured",
    defaultGroupPolicyUnderTest: "disabled",
    missingConfigLabel: "fails closed when channels.imessage is missing and no defaults are set",
    missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
  });
});
