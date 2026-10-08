import type { OpenClawConfig } from "./types.openclaw.js";

class RequiredWorkerProfileError extends Error {
  readonly code = "invalid_profile";
}

/** Configuration is intent; only the placement owner can attest an admitted destination. */
export function assertRequiredWorkerSelection(
  config: Pick<OpenClawConfig, "cloudWorkers">,
  selection: {
    profileId?: string;
    deviceId?: string;
    autoDevice?: boolean;
    machineClass?: string;
    os?: string;
    agentRuntime?: string | null;
    execNode?: string | null;
    catalogId?: string;
  },
): void {
  const required = config.cloudWorkers?.requiredProfile;
  if (!required) {
    return;
  }
  if (
    (selection.profileId !== undefined && selection.profileId !== required) ||
    selection.catalogId !== undefined ||
    selection.deviceId !== undefined ||
    selection.autoDevice === true ||
    selection.machineClass !== undefined ||
    selection.os !== undefined ||
    (selection.execNode !== undefined && selection.execNode !== null) ||
    (selection.agentRuntime !== undefined &&
      selection.agentRuntime !== null &&
      selection.agentRuntime !== "openclaw" &&
      selection.agentRuntime !== "auto" &&
      selection.agentRuntime !== "default")
  ) {
    throw new RequiredWorkerProfileError(
      `Gateway policy requires worker profile "${required}" with the OpenClaw runtime; session execution overrides are not allowed.`,
    );
  }
}

/** Sessionless helpers cannot acquire provider auth under a mandatory placement policy. */
export function requiredWorkerHelperError(
  config: Pick<OpenClawConfig, "cloudWorkers">,
  workerAdmitted = false,
): { error: string } | undefined {
  return config.cloudWorkers?.requiredProfile && !workerAdmitted
    ? {
        error:
          "Sessionless model helpers are unsupported when cloudWorkers.requiredProfile is configured; run the task in a worker-backed session.",
      }
    : undefined;
}

export function assertRequiredWorkerLocalExecution(
  config: Pick<OpenClawConfig, "cloudWorkers">,
  origin: "Gateway" | "Local CLI" | "Local" = "Local",
): void {
  if (config.cloudWorkers?.requiredProfile) {
    throw new Error(`${origin} execution is disabled by the required worker profile policy.`);
  }
}
