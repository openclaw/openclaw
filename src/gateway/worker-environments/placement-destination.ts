import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeCloudRepo } from "../../config/cloud-worker-project-profiles.js";
import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";

const PROJECT_ORIGIN_TIMEOUT_MS = 4_000;

class CloudWorkerProjectProfileError extends Error {
  readonly code = "invalid_profile";
}

export async function resolveProjectProfileDestination(params: {
  cfg: Pick<OpenClawConfig, "cloudWorkers">;
  workspace: WorkerSessionWorkspace;
}) {
  let originUrl = params.workspace.kind === "repository" ? params.workspace.repository.url : "";
  if (params.workspace.kind === "local") {
    try {
      const result = await runCommandWithTimeout(
        ["git", "-C", params.workspace.path, "config", "--get", "remote.origin.url"],
        { timeoutMs: PROJECT_ORIGIN_TIMEOUT_MS },
      );
      if (result.code !== 0) {
        return undefined;
      }
      originUrl = result.stdout.trim();
    } catch {
      return undefined;
    }
  }
  const projectKey = normalizeCloudRepo(originUrl);
  if (!projectKey) {
    return undefined;
  }
  const profileId = params.cfg.cloudWorkers?.projectProfiles?.[projectKey];
  if (!profileId) {
    return undefined;
  }
  if (!Object.hasOwn(params.cfg.cloudWorkers?.profiles ?? {}, profileId)) {
    throw new CloudWorkerProjectProfileError(
      `cloudWorkers.projectProfiles mapping ${projectKey} references unconfigured profile ${profileId}`,
    );
  }
  return { profileId };
}

type WorkerPlacementDestination =
  | {
      profileId: string;
      deviceId?: undefined;
      machineClass?: string;
      os?: string;
      inheritedProfile?: undefined;
    }
  | {
      profileId: string;
      deviceId: string;
      inheritedProfile: NonNullable<WorkerPlacementDispatchRequest["inheritedProfile"]>;
    };

export function resolveWorkerPlacementDestination(params: {
  cfg: Pick<OpenClawConfig, "cloudWorkers">;
  profileId?: string;
  deviceId?: string;
  machineClass?: string;
  os?: string;
}): Result<WorkerPlacementDestination | undefined, string> {
  try {
    assertRequiredWorkerSelection(params.cfg, params);
  } catch (error) {
    return err((error as Error).message);
  }
  const profileId =
    params.cfg.cloudWorkers?.requiredProfile ?? normalizeOptionalString(params.profileId);
  if (profileId) {
    if (!Object.hasOwn(params.cfg.cloudWorkers?.profiles ?? {}, profileId)) {
      return err(`cloud worker profile is not configured: ${profileId}`);
    }
    const machineClass = normalizeOptionalString(params.machineClass);
    if (params.machineClass !== undefined && !machineClass) {
      return err("cloud worker machine class must be non-empty");
    }
    const os = normalizeOptionalString(params.os);
    if (params.os !== undefined && !os) {
      return err("cloud worker operating system must be non-empty");
    }
    return ok({ profileId, ...(machineClass ? { machineClass } : {}), ...(os ? { os } : {}) });
  }
  if (params.os !== undefined || params.machineClass !== undefined) {
    return err("cloud worker machine class and operating system require a profile id");
  }
  const deviceId = normalizeOptionalString(params.deviceId);
  if (!deviceId) {
    return ok(undefined);
  }
  return ok({
    profileId: `device:${deviceId}`,
    deviceId,
    inheritedProfile: {
      providerId: DEVICE_WORKER_PROVIDER_ID,
      profileSnapshot: { install: "bundle", settings: { device: deviceId } },
    },
  });
}
