import { describe, expect, it } from "vitest";
import {
  ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
  INSTALL_DAEMON_HEALTH_DEADLINE_MS,
  resolveLocalGatewayReachabilityPlan,
  type LocalGatewaySetupState,
} from "./onboard-local-gateway.js";
import { createLocalSetupIntent, resolveLocalSetupExecutionPlan } from "./onboard-local-plan.js";

describe("onboard local gateway", () => {
  it("derives token reachability expectations for an existing local gateway", async () => {
    const state: LocalGatewaySetupState = {
      mode: "local",
      port: 18789,
      bind: "loopback",
      authMode: "token",
      gatewayToken: "tok_test",
      tailscaleMode: "off",
      tailscaleResetOnExit: false,
    };
    const executionPlan = resolveLocalSetupExecutionPlan({
      intent: createLocalSetupIntent({
        workspaceDir: "/tmp/openclaw-workspace",
        authChoice: "skip",
      }),
      executionMode: "non-interactive",
      platform: "darwin",
    });

    const plan = await resolveLocalGatewayReachabilityPlan({
      state,
      config: {},
      executionPlan,
    });

    expect(plan).toMatchObject({
      shouldRunHealthCheck: true,
      healthExpectation: "existing-gateway",
      deadlineMs: ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
      wsUrl: "ws://127.0.0.1:18789",
      httpUrl: "http://127.0.0.1:18789/",
      token: "tok_test",
      password: undefined,
    });
  });

  it("derives password reachability expectations for a managed local gateway", async () => {
    const state: LocalGatewaySetupState = {
      mode: "local",
      port: 40123,
      bind: "loopback",
      authMode: "password",
      gatewayPassword: "pw_test", // pragma: allowlist secret
      tailscaleMode: "off",
      tailscaleResetOnExit: false,
    };
    const executionPlan = resolveLocalSetupExecutionPlan({
      intent: createLocalSetupIntent({
        workspaceDir: "/tmp/openclaw-workspace",
        authChoice: "skip",
        installDaemon: true,
      }),
      executionMode: "non-interactive",
      platform: "darwin",
    });

    const plan = await resolveLocalGatewayReachabilityPlan({
      state,
      config: {},
      executionPlan: {
        ...executionPlan,
        healthExpectation: "managed-gateway",
      },
    });

    expect(plan).toMatchObject({
      shouldRunHealthCheck: true,
      healthExpectation: "managed-gateway",
      deadlineMs: INSTALL_DAEMON_HEALTH_DEADLINE_MS,
      wsUrl: "ws://127.0.0.1:40123",
      httpUrl: "http://127.0.0.1:40123/",
      token: undefined,
      password: "pw_test", // pragma: allowlist secret
    });
  });
});
