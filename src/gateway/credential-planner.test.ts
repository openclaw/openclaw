import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createGatewayCredentialPlan } from "./credential-planner.js";

describe("createGatewayCredentialPlan", () => {
  it("ignores remote token winners when gateway.remote.enabled is false", () => {
    const plan = createGatewayCredentialPlan({
      config: {
        gateway: {
          auth: {
            password: "local-password", // pragma: allowlist secret
          },
          remote: {
            enabled: false,
            token: "remote-token",
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(plan.remoteEnabled).toBe(false);
    expect(plan.tokenCanWin).toBe(false);
    expect(plan.passwordCanWin).toBe(true);
    expect(plan.remoteTokenFallbackActive).toBe(false);
    expect(plan.remotePasswordFallbackActive).toBe(false);
  });
});
