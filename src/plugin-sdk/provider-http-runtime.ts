// Shared provider-facing LLM transport helpers. Keep runtime-heavy request
// policy and SSRF-guard wiring off the broad `provider-http` SDK barrel.

export { buildGuardedModelFetch } from "../agents/provider-transport-fetch.js";
import { getModelProviderRequestTransport } from "../agents/provider-request-config.js";

/**
 * Returns the configured request-auth mode attached to a resolved runtime
 * model, if the provider config overrode transport auth behavior.
 */
export function resolveModelRequestAuthMode(
  model: object,
): "provider-default" | "authorization-bearer" | "header" | undefined {
  return getModelProviderRequestTransport(model)?.auth?.mode;
}
