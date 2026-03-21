import type { WizardFlow } from "../wizard/setup.types.js";
import type { AuthChoice } from "./onboard-types.js";

export type LocalSetupDaemonPreference = "install" | "skip" | "default";
export type LocalSetupDaemonDecision = "install" | "skip" | "prompt";
export type LocalSetupHealthExpectation =
  | "skipped"
  | "existing-gateway"
  | "managed-gateway"
  | "pending-daemon-decision";

export type LocalSetupIntent = {
  mode: "local";
  workspaceDir: string;
  authChoice: AuthChoice;
  daemonPreference: LocalSetupDaemonPreference;
  healthRequested: boolean;
};

export type LocalSetupExecutionPlan = {
  daemonDecision: LocalSetupDaemonDecision;
  daemonDecisionReason:
    | "explicit-enable"
    | "explicit-disable"
    | "non-interactive-default"
    | "quickstart-default"
    | "advanced-confirmation"
    | "systemd-unavailable";
  healthExpectation: LocalSetupHealthExpectation;
  shouldRunHealthCheck: boolean;
};

export function createLocalSetupIntent(params: {
  workspaceDir: string;
  authChoice: AuthChoice;
  installDaemon?: boolean;
  skipHealth?: boolean;
}): LocalSetupIntent {
  const daemonPreference: LocalSetupDaemonPreference =
    params.installDaemon === true ? "install" : params.installDaemon === false ? "skip" : "default";

  return {
    mode: "local",
    workspaceDir: params.workspaceDir,
    authChoice: params.authChoice,
    daemonPreference,
    healthRequested: !params.skipHealth,
  };
}

export function resolveLocalSetupExecutionPlan(params: {
  intent: LocalSetupIntent;
  executionMode: "interactive" | "non-interactive";
  flow?: WizardFlow;
  platform: NodeJS.Platform;
  systemdAvailable?: boolean;
}): LocalSetupExecutionPlan {
  const { intent, executionMode, platform, systemdAvailable } = params;
  const flow = params.flow ?? "advanced";

  let daemonDecision: LocalSetupDaemonDecision;
  let daemonDecisionReason: LocalSetupExecutionPlan["daemonDecisionReason"];

  // Keep the shared planner pure and explicit: it decides only what local setup
  // expects to happen, leaving each caller free to keep its own UX and side effects.
  if (intent.daemonPreference === "install") {
    if (executionMode === "interactive" && platform === "linux" && systemdAvailable === false) {
      daemonDecision = "skip";
      daemonDecisionReason = "systemd-unavailable";
    } else {
      daemonDecision = "install";
      daemonDecisionReason = "explicit-enable";
    }
  } else if (intent.daemonPreference === "skip") {
    daemonDecision = "skip";
    daemonDecisionReason = "explicit-disable";
  } else if (executionMode === "non-interactive") {
    daemonDecision = "skip";
    daemonDecisionReason = "non-interactive-default";
  } else if (platform === "linux" && systemdAvailable === false) {
    daemonDecision = "skip";
    daemonDecisionReason = "systemd-unavailable";
  } else if (flow === "quickstart") {
    daemonDecision = "install";
    daemonDecisionReason = "quickstart-default";
  } else {
    daemonDecision = "prompt";
    daemonDecisionReason = "advanced-confirmation";
  }

  const healthExpectation: LocalSetupHealthExpectation = !intent.healthRequested
    ? "skipped"
    : daemonDecision === "install"
      ? "managed-gateway"
      : daemonDecision === "skip"
        ? "existing-gateway"
        : "pending-daemon-decision";

  return {
    daemonDecision,
    daemonDecisionReason,
    healthExpectation,
    shouldRunHealthCheck: healthExpectation !== "skipped",
  };
}
