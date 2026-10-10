import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

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
