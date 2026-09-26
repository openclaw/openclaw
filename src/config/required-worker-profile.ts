import type { OpenClawConfig } from "./types.openclaw.js";

export class RequiredWorkerProfileError extends Error {
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

export function assertRequiredWorkerDispatch(
  config: Pick<OpenClawConfig, "cloudWorkers">,
  request: { profileId: string; executionMode: string; machineClass?: string; os?: string },
): void {
  const required = config.cloudWorkers?.requiredProfile;
  if (!required) {
    return;
  }
  // A recorded profile may carry its original device and settings through recovery.
  // New dispatches cannot use that internal snapshot to choose another profile.
  if (
    request.profileId !== required ||
    request.executionMode !== "worker-turn" ||
    request.machineClass !== undefined ||
    request.os !== undefined
  ) {
    throw new RequiredWorkerProfileError(`Gateway policy requires worker profile "${required}".`);
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
