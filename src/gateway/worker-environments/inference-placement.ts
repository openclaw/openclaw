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
  // Other providers own their settings grammar, including an inference key.
  if (environment.providerId !== DEVICE_WORKER_PROVIDER_ID) {
    return "gateway";
  }
  const settings = environment.profileSnapshot.settings;
  const placement = isRecord(settings) ? settings.inference : undefined;
  if (placement === undefined || placement === "gateway") {
    return "gateway";
  }
  if (placement !== "worker") {
    throw new WorkerProviderError(
      'Invalid device worker profile: cloudWorkers.profiles.<id>.settings.inference must be "gateway" or "worker".',
    );
  }
  return "worker";
}

/** Invalid profiles stay visible for diagnosis without advertising worker inference. */
export function workerInferenceMetadata(environment: WorkerInferenceProfile): {
  inference?: "worker";
} {
  const settings = environment.profileSnapshot.settings;
  try {
    return workerInferencePlacement(environment) === "worker" &&
      isRecord(settings) &&
      typeof settings.device === "string" &&
      settings.device.trim()
      ? { inference: "worker" }
      : {};
  } catch {
    return {};
  }
}
