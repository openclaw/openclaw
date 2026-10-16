import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";

/** Scheduler-owned identity, not a user model pin or a copy of credential material. */
export type CronInferenceBinding = {
  version: 1;
  provider: string;
  profileId: string;
  authorizationId: string;
  authRequirement: ProviderModelRouteAuthRequirement;
  source: "auto" | "user";
};

/** Stored bindings are private scheduler state, never accepted from public job input. */
export function normalizeCronInferenceBinding(value: unknown): CronInferenceBinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Invalid automation inference binding.");
  }
  const binding = value;
  if (
    binding.version !== 1 ||
    typeof binding.provider !== "string" ||
    !binding.provider.trim() ||
    typeof binding.profileId !== "string" ||
    !binding.profileId.trim() ||
    typeof binding.authorizationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.authorizationId) ||
    (binding.authRequirement !== "api-key" && binding.authRequirement !== "subscription") ||
    (binding.source !== "auto" && binding.source !== "user")
  ) {
    throw new Error("Invalid automation inference binding; explicitly select an account again.");
  }
  return {
    version: 1,
    provider: binding.provider,
    profileId: binding.profileId,
    authorizationId: binding.authorizationId,
    authRequirement: binding.authRequirement,
    source: binding.source,
  };
}
