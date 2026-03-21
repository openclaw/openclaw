import type { WizardFlow } from "../wizard/setup.types.js";
import type { LocalGatewaySetupState } from "./onboard-local-gateway.js";
import type { LocalSetupExecutionPlan, LocalSetupIntent } from "./onboard-local-plan.js";
import type { OnboardOptions } from "./onboard-types.js";

export type OnboardingExecutionMode = "interactive" | "non-interactive";

export type OnboardingPlanSimpleStepId =
  | "workspace"
  | "auth"
  | "gateway"
  | "channels"
  | "search"
  | "skills"
  | "hooks"
  | "ui";

export type OnboardingSimpleStep = {
  id: OnboardingPlanSimpleStepId;
  decision: "run" | "skip";
  reason: "baseline" | "user-skip" | "unsupported-non-interactive" | "interactive-only";
};

export type OnboardingDaemonStep = {
  id: "daemon";
  decision: LocalSetupExecutionPlan["daemonDecision"];
  reason: LocalSetupExecutionPlan["daemonDecisionReason"];
};

export type OnboardingHealthStep = {
  id: "health";
  decision: "run" | "skip";
  expectation: LocalSetupExecutionPlan["healthExpectation"];
  reason: "execution-plan" | "gateway-health-skipped";
};

export type OnboardingPlan = {
  mode: "local";
  executionMode: OnboardingExecutionMode;
  flow?: WizardFlow;
  intent: LocalSetupIntent;
  gatewayState: LocalGatewaySetupState;
  executionPlan: Pick<
    LocalSetupExecutionPlan,
    "daemonDecision" | "healthExpectation" | "shouldRunHealthCheck"
  >;
  steps: {
    workspace: OnboardingSimpleStep;
    auth: OnboardingSimpleStep;
    gateway: OnboardingSimpleStep;
    channels: OnboardingSimpleStep;
    search: OnboardingSimpleStep;
    skills: OnboardingSimpleStep;
    hooks: OnboardingSimpleStep;
    daemon: OnboardingDaemonStep;
    health: OnboardingHealthStep;
    ui: OnboardingSimpleStep;
  };
};

function simpleStep(
  id: OnboardingPlanSimpleStepId,
  decision: OnboardingSimpleStep["decision"],
  reason: OnboardingSimpleStep["reason"],
): OnboardingSimpleStep {
  return { id, decision, reason };
}

export function createLocalOnboardingPlan(params: {
  executionMode: OnboardingExecutionMode;
  flow?: WizardFlow;
  intent: LocalSetupIntent;
  gatewayState: LocalGatewaySetupState;
  executionPlan: Pick<
    LocalSetupExecutionPlan,
    "daemonDecision" | "healthExpectation" | "shouldRunHealthCheck"
  >;
  opts: OnboardOptions;
}): OnboardingPlan {
  const skipChannels = Boolean(params.opts.skipChannels ?? params.opts.skipProviders);
  const skipSearch = Boolean(params.opts.skipSearch);
  const skipSkills = Boolean(params.opts.skipSkills);
  const skipUi = Boolean(params.opts.skipUi);
  const { executionPlan } = params;

  // Keep the shared onboarding graph pure: it decides which sections/finalize
  // actions should run, while wizard and CLI paths keep their own prompts and writes.
  return {
    mode: "local",
    executionMode: params.executionMode,
    flow: params.flow,
    intent: params.intent,
    gatewayState: params.gatewayState,
    executionPlan,
    steps: {
      workspace: simpleStep("workspace", "run", "baseline"),
      auth: simpleStep("auth", "run", "baseline"),
      gateway: simpleStep("gateway", "run", "baseline"),
      channels:
        params.executionMode === "interactive"
          ? simpleStep(
              "channels",
              skipChannels ? "skip" : "run",
              skipChannels ? "user-skip" : "baseline",
            )
          : simpleStep("channels", "skip", "unsupported-non-interactive"),
      search:
        params.executionMode === "interactive"
          ? simpleStep("search", skipSearch ? "skip" : "run", skipSearch ? "user-skip" : "baseline")
          : simpleStep("search", "skip", "unsupported-non-interactive"),
      skills: simpleStep(
        "skills",
        skipSkills ? "skip" : "run",
        skipSkills ? "user-skip" : "baseline",
      ),
      hooks:
        params.executionMode === "interactive"
          ? simpleStep("hooks", "run", "interactive-only")
          : simpleStep("hooks", "skip", "unsupported-non-interactive"),
      daemon: {
        id: "daemon",
        decision: executionPlan.daemonDecision,
        reason: executionPlan.daemonDecisionReason,
      },
      health: {
        id: "health",
        decision: executionPlan.shouldRunHealthCheck ? "run" : "skip",
        expectation: executionPlan.healthExpectation,
        reason: executionPlan.shouldRunHealthCheck ? "execution-plan" : "gateway-health-skipped",
      },
      ui:
        params.executionMode === "interactive"
          ? simpleStep("ui", skipUi ? "skip" : "run", skipUi ? "user-skip" : "interactive-only")
          : simpleStep("ui", "skip", "unsupported-non-interactive"),
    },
  };
}
