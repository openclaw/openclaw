import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

/** The host retains error presentation and conversation cleanup at the write boundary. */
export async function requireSystemAgentPersistentApplyInference(
  params: Parameters<typeof import("./setup-inference.js").resolvePersistentApplyInference>[0],
  onUnavailable: (failures: readonly unknown[]) => never,
) {
  if (!params.binding) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  try {
    const { resolvePersistentApplyInference } = await import("./setup-inference.js");
    const route = await resolvePersistentApplyInference(params);
    if (route) {
      return route;
    }
  } catch (error) {
    return onUnavailable([error]);
  }
  return onUnavailable([]);
}

/** Read guards share failure classification; the conversation retains cleanup ownership. */
export async function requireSystemAgentInferenceRoute(
  binding: SystemAgentVerifiedInferenceBinding | undefined,
  deps: SystemAgentVerifiedInferenceDeps | undefined,
  stage: ConstructorParameters<typeof SystemAgentInferenceUnavailableError>[0],
  onUnavailable?: (failures: readonly unknown[]) => void,
) {
  let failures: unknown[] = [];
  if (binding) {
    try {
      const route = await resolveSystemAgentVerifiedInferenceRoute(binding, deps);
      if (route) {
        return route;
      }
    } catch (error) {
      failures = [error];
    }
  }
  onUnavailable?.(failures);
  throw new SystemAgentInferenceUnavailableError(
    stage,
    failures,
    binding ? "route-changed" : "setup",
  );
}
