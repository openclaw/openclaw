import { describe, expect, it } from "vitest";
import type { LocalGatewaySetupState } from "./onboard-local-gateway.js";
import { createLocalSetupIntent, resolveLocalSetupExecutionPlan } from "./onboard-local-plan.js";
import { createLocalOnboardingPlan } from "./onboard-plan.js";

function createGatewayState(): LocalGatewaySetupState {
  return {
    mode: "local",
    port: 18789,
    bind: "loopback",
    authMode: "token",
    gatewayToken: "tok_test",
    tailscaleMode: "off",
    tailscaleResetOnExit: false,
  };
}

describe("createLocalOnboardingPlan", () => {
  it("marks interactive advanced optional steps as runnable by default", () => {
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "skip",
    });
    const executionPlan = resolveLocalSetupExecutionPlan({
      intent,
      executionMode: "interactive",
      flow: "advanced",
      platform: "darwin",
    });

    const plan = createLocalOnboardingPlan({
      executionMode: "interactive",
      flow: "advanced",
      intent,
      gatewayState: createGatewayState(),
      executionPlan,
      opts: {},
    });

    expect(plan.steps.channels).toMatchObject({ decision: "run", reason: "baseline" });
    expect(plan.steps.search).toMatchObject({ decision: "run", reason: "baseline" });
    expect(plan.steps.skills).toMatchObject({ decision: "run", reason: "baseline" });
    expect(plan.steps.hooks).toMatchObject({ decision: "run", reason: "interactive-only" });
    expect(plan.steps.daemon).toMatchObject({
      decision: "prompt",
      reason: "advanced-confirmation",
    });
    expect(plan.steps.health).toMatchObject({
      decision: "run",
      expectation: "pending-daemon-decision",
      reason: "execution-plan",
    });
    expect(plan.steps.ui).toMatchObject({ decision: "run", reason: "interactive-only" });
  });

  it("marks non-interactive local onboarding unsupported steps as skipped", () => {
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "skip",
      installDaemon: true,
      skipHealth: true,
    });
    const executionPlan = resolveLocalSetupExecutionPlan({
      intent,
      executionMode: "non-interactive",
      platform: "darwin",
    });

    const plan = createLocalOnboardingPlan({
      executionMode: "non-interactive",
      intent,
      gatewayState: createGatewayState(),
      executionPlan,
      opts: {
        skipSkills: true,
        installDaemon: true,
        skipHealth: true,
      },
    });

    expect(plan.steps.channels).toMatchObject({
      decision: "skip",
      reason: "unsupported-non-interactive",
    });
    expect(plan.steps.search).toMatchObject({
      decision: "skip",
      reason: "unsupported-non-interactive",
    });
    expect(plan.steps.hooks).toMatchObject({
      decision: "skip",
      reason: "unsupported-non-interactive",
    });
    expect(plan.steps.skills).toMatchObject({ decision: "skip", reason: "user-skip" });
    expect(plan.steps.daemon).toMatchObject({ decision: "install", reason: "explicit-enable" });
    expect(plan.steps.health).toMatchObject({
      decision: "skip",
      expectation: "skipped",
      reason: "gateway-health-skipped",
    });
    expect(plan.steps.ui).toMatchObject({
      decision: "skip",
      reason: "unsupported-non-interactive",
    });
  });

  it("keeps shared local gateway facts identical across interactive and non-interactive plans", () => {
    const gatewayState = createGatewayState();
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "skip",
    });

    const interactive = createLocalOnboardingPlan({
      executionMode: "interactive",
      flow: "quickstart",
      intent,
      gatewayState,
      executionPlan: resolveLocalSetupExecutionPlan({
        intent,
        executionMode: "interactive",
        flow: "quickstart",
        platform: "darwin",
      }),
      opts: {},
    });
    const nonInteractive = createLocalOnboardingPlan({
      executionMode: "non-interactive",
      intent,
      gatewayState,
      executionPlan: resolveLocalSetupExecutionPlan({
        intent,
        executionMode: "non-interactive",
        platform: "darwin",
      }),
      opts: {},
    });

    expect(interactive.gatewayState).toEqual(nonInteractive.gatewayState);
  });
});
