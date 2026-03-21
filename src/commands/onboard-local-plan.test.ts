import { describe, expect, it } from "vitest";
import { createLocalSetupIntent, resolveLocalSetupExecutionPlan } from "./onboard-local-plan.js";

describe("onboard local plan", () => {
  it("defaults non-interactive local setup to attaching to an existing gateway", () => {
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "skip",
    });

    const plan = resolveLocalSetupExecutionPlan({
      intent,
      executionMode: "non-interactive",
      platform: "darwin",
    });

    expect(plan).toMatchObject({
      daemonDecision: "skip",
      daemonDecisionReason: "non-interactive-default",
      healthExpectation: "existing-gateway",
      shouldRunHealthCheck: true,
    });
  });

  it("defaults quickstart local setup to installing the gateway service", () => {
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "setup-token",
    });

    const plan = resolveLocalSetupExecutionPlan({
      intent,
      executionMode: "interactive",
      flow: "quickstart",
      platform: "darwin",
    });

    expect(plan).toMatchObject({
      daemonDecision: "install",
      daemonDecisionReason: "quickstart-default",
      healthExpectation: "managed-gateway",
      shouldRunHealthCheck: true,
    });
  });

  it("marks advanced local setup as needing a daemon decision prompt by default", () => {
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "skip",
    });

    const plan = resolveLocalSetupExecutionPlan({
      intent,
      executionMode: "interactive",
      flow: "advanced",
      platform: "darwin",
    });

    expect(plan).toMatchObject({
      daemonDecision: "prompt",
      daemonDecisionReason: "advanced-confirmation",
      healthExpectation: "pending-daemon-decision",
      shouldRunHealthCheck: true,
    });
  });

  it("skips daemon install on interactive Linux when systemd user services are unavailable", () => {
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "skip",
      installDaemon: true,
    });

    const plan = resolveLocalSetupExecutionPlan({
      intent,
      executionMode: "interactive",
      flow: "advanced",
      platform: "linux",
      systemdAvailable: false,
    });

    expect(plan).toMatchObject({
      daemonDecision: "skip",
      daemonDecisionReason: "systemd-unavailable",
      healthExpectation: "existing-gateway",
      shouldRunHealthCheck: true,
    });
  });

  it("tracks when health checks were explicitly skipped", () => {
    const intent = createLocalSetupIntent({
      workspaceDir: "/tmp/openclaw-workspace",
      authChoice: "skip",
      skipHealth: true,
    });

    const plan = resolveLocalSetupExecutionPlan({
      intent,
      executionMode: "non-interactive",
      platform: "darwin",
    });

    expect(plan).toMatchObject({
      daemonDecision: "skip",
      healthExpectation: "skipped",
      shouldRunHealthCheck: false,
    });
  });
});
