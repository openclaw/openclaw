import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WorkerProviderError } from "../../plugins/capability-provider.types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";

type WorkerInferenceProfile = {
  providerId: string;
  profileSnapshot: { settings?: unknown };
};

/** Inference placement is a recorded provider-profile choice, not a worker fallback. */
export function workerInferencePlacement(
  environment: WorkerInferenceProfile,
): "gateway" | "worker" {
  const settings = environment.profileSnapshot.settings;
  const placement = isRecord(settings) ? settings.inference : undefined;
  if (placement === undefined || placement === "gateway") {
    return "gateway";
  }
  // Preserve opt-in snapshots from pre-release builds until their environments retire.
  // This spelling was not a released contract. Doctor normalizes authored config; reading
  // an existing snapshot must not rewrite it or silently change inference placement.
  if (
    (placement !== "worker" && placement !== "runtime-local") ||
    environment.providerId !== DEVICE_WORKER_PROVIDER_ID
  ) {
    throw new WorkerProviderError(
      "Worker inference requires an explicitly configured paired-device worker profile; use gateway or worker",
    );
  }
  return "worker";
}
