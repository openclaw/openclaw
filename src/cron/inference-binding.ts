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
  /**
   * The runtime the account was captured for. Runs execute on it instead of re-deriving one
   * from the cron session entry; bindings captured before it existed keep that derivation.
   */
  runtime?: string;
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
    (binding.source !== "auto" && binding.source !== "user") ||
    (binding.runtime !== undefined &&
      (typeof binding.runtime !== "string" || !binding.runtime.trim()))
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
    ...(binding.runtime !== undefined ? { runtime: binding.runtime } : {}),
  };
}

/**
 * The session runtime fields a run resolves its runtime from. A binding with a captured
 * runtime supplies it, so a runtime override copied into the cron session entry cannot move
 * the job onto a runtime its account was not captured for.
 */
export function resolveCronRuntimeSessionEntry<
  T extends { agentRuntimeOverride?: string; agentHarnessId?: string },
>(binding: CronInferenceBinding | undefined, entry: T): T | { agentRuntimeOverride: string } {
  return binding?.runtime ? { agentRuntimeOverride: binding.runtime } : entry;
}

/** Names a binding's account and captured runtime for scheduled-run errors. */
export function describeCronInferenceBinding(binding: CronInferenceBinding): string {
  return binding.runtime
    ? `account ${binding.profileId} on runtime ${binding.runtime}`
    : `account ${binding.profileId} (no recorded runtime)`;
}
