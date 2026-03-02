import type { OpenClawConfig } from "../config/config.js";
import type { SecretProviderConfig, SecretRef, SecretRefSource } from "../config/types.secrets.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import {
  type ProviderResolutionOutput,
  type ResolutionLimits,
  resolveProviderRefs,
  type SecretRefResolveCache,
} from "./provider-resolvers.js";
import { resolveDefaultSecretProviderAlias, secretRefKey } from "./ref-contract.js";
import { isNonEmptyString, normalizePositiveInt } from "./shared.js";

const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_MAX_REFS_PER_PROVIDER = 512;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;

type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};

function resolveResolutionLimits(config: OpenClawConfig): ResolutionLimits {
  const resolution = config.secrets?.resolution;
  return {
    maxProviderConcurrency: normalizePositiveInt(
      resolution?.maxProviderConcurrency,
      DEFAULT_PROVIDER_CONCURRENCY,
    ),
    maxRefsPerProvider: normalizePositiveInt(
      resolution?.maxRefsPerProvider,
      DEFAULT_MAX_REFS_PER_PROVIDER,
    ),
    maxBatchBytes: normalizePositiveInt(resolution?.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES),
  };
}

function toProviderKey(source: SecretRefSource, provider: string): string {
  return `${source}:${provider}`;
}

function resolveConfiguredProvider(ref: SecretRef, config: OpenClawConfig): SecretProviderConfig {
  const providerConfig = config.secrets?.providers?.[ref.provider];
  if (!providerConfig) {
    if (ref.source === "env" && ref.provider === resolveDefaultSecretProviderAlias(config, "env")) {
      return { source: "env" };
    }
    throw new Error(
      `Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`,
    );
  }
  if (providerConfig.source !== ref.source) {
    throw new Error(
      `Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
    );
  }
  return providerConfig;
}

export async function resolveSecretRefValues(
  refs: SecretRef[],
  options: ResolveSecretRefOptions,
): Promise<Map<string, unknown>> {
  if (refs.length === 0) {
    return new Map();
  }
  const limits = resolveResolutionLimits(options.config);
  const uniqueRefs = new Map<string, SecretRef>();
  for (const ref of refs) {
    const id = ref.id.trim();
    if (!id) {
      throw new Error("Secret reference id is empty.");
    }
    uniqueRefs.set(secretRefKey(ref), { ...ref, id });
  }

  const grouped = new Map<
    string,
    { source: SecretRefSource; providerName: string; refs: SecretRef[] }
  >();
  for (const ref of uniqueRefs.values()) {
    const key = toProviderKey(ref.source, ref.provider);
    const existing = grouped.get(key);
    if (existing) {
      existing.refs.push(ref);
      continue;
    }
    grouped.set(key, { source: ref.source, providerName: ref.provider, refs: [ref] });
  }

  const taskEnv = options.env ?? process.env;
  const tasks = [...grouped.values()].map(
    (group) => async (): Promise<{ group: typeof group; values: ProviderResolutionOutput }> => {
      if (group.refs.length > limits.maxRefsPerProvider) {
        throw new Error(
          `Secret provider "${group.providerName}" exceeded maxRefsPerProvider (${limits.maxRefsPerProvider}).`,
        );
      }
      const providerConfig = resolveConfiguredProvider(group.refs[0], options.config);
      const values = await resolveProviderRefs({
        refs: group.refs,
        providerName: group.providerName,
        providerConfig,
        env: taskEnv,
        cache: options.cache,
        limits,
      });
      return { group, values };
    },
  );

  const taskResults = await runTasksWithConcurrency({
    tasks,
    limit: limits.maxProviderConcurrency,
    errorMode: "stop",
  });
  if (taskResults.hasError) {
    throw taskResults.firstError;
  }

  const resolved = new Map<string, unknown>();
  for (const result of taskResults.results) {
    for (const ref of result.group.refs) {
      if (!result.values.has(ref.id)) {
        throw new Error(
          `Secret provider "${result.group.providerName}" did not return id "${ref.id}".`,
        );
      }
      resolved.set(secretRefKey(ref), result.values.get(ref.id));
    }
  }
  return resolved;
}

export async function resolveSecretRefValue(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<unknown> {
  const cache = options.cache;
  const key = secretRefKey(ref);
  if (cache?.resolvedByRefKey?.has(key)) {
    return await (cache.resolvedByRefKey.get(key) as Promise<unknown>);
  }

  const promise = (async () => {
    const resolved = await resolveSecretRefValues([ref], options);
    if (!resolved.has(key)) {
      throw new Error(`Secret reference "${key}" resolved to no value.`);
    }
    return resolved.get(key);
  })();

  if (cache) {
    cache.resolvedByRefKey ??= new Map();
    cache.resolvedByRefKey.set(key, promise);
  }
  return await promise;
}

export async function resolveSecretRefString(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<string> {
  const resolved = await resolveSecretRefValue(ref, options);
  if (!isNonEmptyString(resolved)) {
    throw new Error(
      `Secret reference "${ref.source}:${ref.provider}:${ref.id}" resolved to a non-string or empty value.`,
    );
  }
  return resolved;
}

export type { SecretRefResolveCache };
