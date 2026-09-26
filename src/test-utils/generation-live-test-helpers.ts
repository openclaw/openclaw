// Live-test helpers for generation provider credentials and config loading.
import { loadShellEnvFallback } from "../infra/shell-env.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";

/** Loads shell env only when a live generation provider declares missing key names. */
export function maybeLoadShellEnvForGenerationProviders(providerIds: string[]): void {
  const expectedKeys = [
    ...new Set(providerIds.flatMap((providerId) => getProviderEnvVarsCore(providerId))),
  ];
  if (expectedKeys.length === 0) {
    return;
  }
  loadShellEnvFallback({
    enabled: true,
    env: process.env,
    expectedKeys,
    logger: { warn: (message: string) => console.warn(message) },
  });
}
