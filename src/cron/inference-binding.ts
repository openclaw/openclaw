import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";

/** One provider's recorded account: an identity, not a copy of credential material. */
export type CronInferenceAccount = {
  provider: string;
  profileId: string;
  authorizationId: string;
  authRequirement: ProviderModelRouteAuthRequirement;
  /**
   * The runtime the account was captured for. Runs execute on it instead of re-deriving one
   * from the cron session entry; bindings captured before it existed keep that derivation.
   */
  runtime?: string;
  /**
   * Fallback accounts only: `user` when the owner named it with `@profile`, `auto` when it was
   * recorded on their behalf. The primary's source lives on the binding.
   */
  source?: "auto" | "user";
};

/** Scheduler-owned identity, not a user model pin or a copy of credential material. */
export type CronInferenceBinding = CronInferenceAccount & {
  version: 1;
  source: "auto" | "user";
  /**
   * Accounts recorded for fallback candidates on other providers, at most one per provider.
   * A fallback provider without one is refused, exactly like an unrecorded primary.
   */
  fallbackAccounts?: CronInferenceAccount[];
};

const invalidBinding = () =>
  new Error("Invalid automation inference binding; explicitly select an account again.");

function normalizeAccount(value: unknown): CronInferenceAccount {
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.profileId !== "string" ||
    !value.profileId.trim() ||
    typeof value.authorizationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.authorizationId) ||
    (value.authRequirement !== "api-key" && value.authRequirement !== "subscription") ||
    (value.runtime !== undefined && (typeof value.runtime !== "string" || !value.runtime.trim()))
  ) {
    throw invalidBinding();
  }
  return {
    provider: value.provider,
    profileId: value.profileId,
    authorizationId: value.authorizationId,
    authRequirement: value.authRequirement,
    ...(value.runtime !== undefined ? { runtime: value.runtime } : {}),
  };
}

function normalizeFallbackAccount(value: unknown): CronInferenceAccount {
  const account = normalizeAccount(value);
  const source = isRecord(value) ? value.source : undefined;
  if (source !== undefined && source !== "auto" && source !== "user") {
    throw invalidBinding();
  }
  return source ? { ...account, source } : account;
}

/** Stored bindings are private scheduler state, never accepted from public job input. */
export function normalizeCronInferenceBinding(value: unknown): CronInferenceBinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Invalid automation inference binding.");
  }
  if (value.version !== 1 || (value.source !== "auto" && value.source !== "user")) {
    throw invalidBinding();
  }
  const primary = normalizeAccount(value);
  let fallbackAccounts: CronInferenceAccount[] | undefined;
  if (value.fallbackAccounts !== undefined) {
    if (!Array.isArray(value.fallbackAccounts)) {
      throw invalidBinding();
    }
    fallbackAccounts = value.fallbackAccounts.map(normalizeFallbackAccount);
    const providers = new Set([primary.provider]);
    for (const account of fallbackAccounts) {
      if (providers.has(account.provider)) {
        throw invalidBinding();
      }
      providers.add(account.provider);
    }
  }
  return {
    version: 1,
    ...primary,
    source: value.source,
    ...(fallbackAccounts?.length ? { fallbackAccounts } : {}),
  };
}

/**
 * Doctor may record an account for an unbound job, or add fallback-provider accounts to a bound
 * one; it never replaces or removes an account that is already recorded.
 */
export function isCronInferenceBindingAddition(
  previous: CronInferenceBinding | undefined,
  next: CronInferenceBinding,
): boolean {
  if (!previous) {
    return true;
  }
  const { fallbackAccounts: previousFallbacks = [], ...previousPrimary } = previous;
  const { fallbackAccounts: nextFallbacks = [], ...nextPrimary } = next;
  return (
    isDeepStrictEqual(previousPrimary, nextPrimary) &&
    nextFallbacks.length > previousFallbacks.length &&
    previousFallbacks.every((account, index) => isDeepStrictEqual(account, nextFallbacks[index]))
  );
}

/** The recorded account a candidate on `provider` must use, if the job has one. */
export function resolveCronInferenceAccount(
  binding: CronInferenceBinding,
  provider: string,
): CronInferenceAccount | undefined {
  return binding.provider === provider
    ? binding
    : binding.fallbackAccounts?.find((account) => account.provider === provider);
}

/**
 * The session runtime fields a run resolves its runtime from. A binding with a captured
 * runtime supplies it, so a runtime override copied into the cron session entry cannot move
 * the job onto a runtime its account was not captured for.
 */
export function resolveCronRuntimeSessionEntry<
  T extends { agentRuntimeOverride?: string; agentHarnessId?: string },
>(binding: CronInferenceAccount | undefined, entry: T): T | { agentRuntimeOverride: string } {
  return binding?.runtime ? { agentRuntimeOverride: binding.runtime } : entry;
}

/** Names a recorded account and captured runtime for scheduled-run errors. */
export function describeCronInferenceBinding(binding: CronInferenceAccount): string {
  return binding.runtime
    ? `account ${binding.profileId} on runtime ${binding.runtime}`
    : `account ${binding.profileId} (no recorded runtime)`;
}
