import { afterEach, describe, expect, it } from "vitest";
import { withUpdateRuntimeActivationPolicy } from "./update-command-service-env.js";

const UPDATE_RUNTIME_ACTIVATION_POLICY_ENV = "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION";

describe("withUpdateRuntimeActivationPolicy", () => {
  const originalPolicy = process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV];

  afterEach(() => {
    if (originalPolicy === undefined) {
      delete process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV];
    } else {
      process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV] = originalPolicy;
    }
  });

  it("scopes manual activation through update subprocess environments", async () => {
    delete process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV];

    await withUpdateRuntimeActivationPolicy(false, async () => {
      expect(process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV]).toBe("0");
    });

    expect(process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV]).toBeUndefined();
  });

  it("clears an ambient manual policy for restart-enabled updates", async () => {
    process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV] = "0";

    await withUpdateRuntimeActivationPolicy(true, async () => {
      expect(process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV]).toBe("1");
    });

    expect(process.env[UPDATE_RUNTIME_ACTIVATION_POLICY_ENV]).toBe("0");
  });
});
