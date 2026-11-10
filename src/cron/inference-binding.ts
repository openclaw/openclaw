import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";
import { modelKey } from "../shared/model-key.js";

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

/** Unordered authorizations. The payload/default policy alone owns candidate ordering. */
export type CronInferenceGrants = Record<string, CronInferenceBinding>;

/** The original primary keeps its account/runtime even when an old optional grant matches it. */
export function resolveCronCandidateInferenceBinding(
  params: {
    binding?: CronInferenceBinding;
    grants?: CronInferenceGrants;
    primary: { provider: string; model: string };
  },
  provider: string,
  model: string,
): CronInferenceBinding | undefined {
  return params.grants === undefined ||
    modelKey(provider, model) === modelKey(params.primary.provider, params.primary.model)
    ? params.binding
    : params.grants[modelKey(provider, model)];
}

export function normalizeCronInferenceGrants(value: unknown): CronInferenceGrants | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Invalid automation inference grants.");
  }
  const grants: CronInferenceGrants = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    const binding = normalizeCronInferenceBinding(raw);
    if (
      !binding ||
      !key.startsWith(binding.provider + "/") ||
      key.length <= binding.provider.length + 1
    ) {
      throw new Error("Invalid automation inference grant; review the model policy again.");
    }
    grants[key] = binding;
  }
  return grants;
}

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

export function describeCronInferenceBinding(binding: CronInferenceBinding): string {
  return binding.runtime
    ? `account ${binding.profileId} on runtime ${binding.runtime}`
    : `account ${binding.profileId} (no recorded runtime)`;
}
