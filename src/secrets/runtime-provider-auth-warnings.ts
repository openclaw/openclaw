/** Keeps provider-auth refresh warnings aligned with the state that refresh publishes. */
import type { SecretResolverWarning } from "./runtime-shared.js";

export function selectProviderAuthRuntimeWarnings(
  warnings: readonly SecretResolverWarning[],
): SecretResolverWarning[] {
  return warnings.filter(
    (warning) =>
      warning.path.startsWith("models.providers.") || warning.path.includes(".auth-profiles."),
  );
}
