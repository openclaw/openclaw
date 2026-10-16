/** Resolves SecretRef values from env, file, exec, and store secret providers. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isRedactedSecretValue } from "../config/redact-sentinel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretProviderConfig, SecretRef, SecretRefSource } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { FsSafeError, readSecureFile } from "../infra/fs-safe.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { resolveUserPath } from "../utils.js";
import { assertSecureExecCommandPath } from "./exec-provider-path-validation.js";
import { readJsonPointer } from "./json-pointer.js";
import {
  isPluginIntegrationSecretProviderConfig,
  resolveSecretProviderIntegrationConfig,
} from "./provider-integrations.js";
import {
  isBuiltInDefaultSecretProviderRef,
  type ProviderRefGroup,
  resolveSecretRefProviderSourceMismatch,
  secretRefKey,
  SINGLE_VALUE_FILE_REF_ID,
} from "./ref-contract.js";
import { resolveProviderGroups, type ProviderRefGroupResult } from "./resolve-batch.js";
import {
  isProviderScopedSecretResolutionError,
  isSecretResolutionError,
  providerResolutionError,
  refResolutionError,
} from "./resolve-errors.js";
import { resolveProviderRefGroupWithCache } from "./resolve-ref-cache.js";
import { resolveStoreRefs } from "./resolve-store.js";
import type { SecretRefErrorHandler, SecretRefResolveCache } from "./resolve-types.js";
import {
  isNonEmptyString,
  isRecord,
  normalizePositiveInt,
  normalizePositiveTimerMs,
} from "./shared.js";

const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_MAX_REFS_PER_PROVIDER = 512;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
// Exec diagnostics cross CLI, RPC, and log boundaries; surface only canonical safe codes.
const SAFE_EXEC_ERROR_CODES = new Set(["AMBIGUOUS_DUPLICATE_KEY", "NOT_FOUND"]);

export type { SecretRefResolveCache } from "./resolve-types.js";

type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
};

type ProviderResolutionOutput = Map<string, unknown>;

export { isProviderScopedSecretResolutionError };

function resolveConfiguredProvider(params: {
  ref: SecretRef;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): SecretProviderConfig {
  const { ref, config } = params;
  const providerConfig = config.secrets?.providers?.[ref.provider];
  if (isBuiltInDefaultSecretProviderRef(config, ref)) {
    if (ref.source === "env" || ref.source === "store") {
      return { source: ref.source };
    }
  }
  if (!providerConfig) {
    throw providerResolutionError({
      code: "SECRET_PROVIDER_NOT_CONFIGURED",
      source: ref.source,
      provider: ref.provider,
      message: `Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`,
    });
  }
  const configuredSource = resolveSecretRefProviderSourceMismatch(config, ref);
  if (configuredSource) {
    throw providerResolutionError({
      code: "SECRET_PROVIDER_INVALID",
      source: ref.source,
      provider: ref.provider,
      message: `Secret provider "${ref.provider}" has source "${configuredSource}" but ref requests "${ref.source}".`,
    });
  }
  if (isPluginIntegrationSecretProviderConfig(providerConfig)) {
    const manifestRegistry =
      params.manifestRegistry ??
      getCurrentPluginMetadataSnapshot({
        config,
        env: params.env,
        allowWorkspaceScopedSnapshot: true,
      })?.manifestRegistry ??
      loadPluginManifestRegistryCore({
        config,
        env: params.env,
      });
    const resolved = resolveSecretProviderIntegrationConfig({
      manifestRegistry,
      providerAlias: ref.provider,
      providerConfig,
      config,
      env: params.env,
    });
    if (!resolved.ok) {
      throw providerResolutionError({
        source: ref.source,
        provider: ref.provider,
        message: `Secret provider "${ref.provider}" plugin integration is unavailable: ${resolved.reason}.`,
      });
    }
    return resolved.providerConfig;
  }
  return providerConfig;
}

async function resolveProviderRefs({
  refs,
  source,
  providerName,
  onRefError,
  providerConfig,
  options,
}: {
  refs: SecretRef[];
  source: SecretRefSource;
  providerName: string;
  onRefError: SecretRefErrorHandler;
  providerConfig: SecretProviderConfig;
  options: ResolveSecretRefOptions;
}): Promise<ProviderResolutionOutput> {
  try {
    if (providerConfig.source === "env") {
      const env = options.env ?? process.env;
      const resolved = new Map<string, unknown>();
      const allowlist = providerConfig.allowlist ? new Set(providerConfig.allowlist) : null;
      for (const ref of refs) {
        if (allowlist && !allowlist.has(ref.id)) {
          onRefError(
            refResolutionError({
              code: "SECRET_REF_POLICY_DENIED",
              source: "env",
              provider: providerName,
              refId: ref.id,
              message: `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${providerName}.allowlist.`,
            }),
          );
          continue;
        }
        const envValue = env[ref.id];
        if (!isNonEmptyString(envValue)) {
          onRefError(
            refResolutionError({
              code: "SECRET_REF_NOT_FOUND",
              source: "env",
              provider: providerName,
              refId: ref.id,
              message: `Environment variable "${ref.id}" is missing or empty.`,
            }),
          );
          continue;
        }
        resolved.set(ref.id, envValue);
      }
      return resolved;
    }
    if (providerConfig.source === "file") {
      const cache = options.cache;
      const read = async () => {
        const filePath = resolveUserPath(providerConfig.path);
        const timeoutMs = normalizePositiveTimerMs(
          providerConfig.timeoutMs,
          DEFAULT_FILE_TIMEOUT_MS,
        );
        const maxBytes = normalizePositiveInt(providerConfig.maxBytes, DEFAULT_FILE_MAX_BYTES);
        try {
          const { buffer: payload } = await readSecureFile({
            filePath,
            label: `secrets.providers.${providerName}.path`,
            io: { maxBytes, timeoutMs },
            permissions: { allowInsecure: false },
          });
          const text = payload.toString("utf8").replace(/^\uFEFF/, "");
          if (providerConfig.mode === "singleValue") {
            return text.replace(/\r?\n$/, "");
          }
          const parsed = JSON.parse(text) as unknown;
          if (!isRecord(parsed)) {
            throw new Error(`File provider "${providerName}" payload is not a JSON object.`);
          }
          return parsed;
        } catch (error) {
          if (error instanceof FsSafeError && error.code === "timeout") {
            throw new Error(`File provider "${providerName}" timed out after ${timeoutMs}ms.`, {
              cause: error,
            });
          }
          throw error;
        }
      };

      let payload: unknown;
      if (!cache) {
        payload = await read();
      } else {
        // Cache the in-flight read, not just the fulfilled payload, so concurrent refs share one
        // permission-checked file read and observe the same provider error.
        cache.filePayloadByProvider ??= new Map();
        payload = await getOrCreatePromise(cache.filePayloadByProvider, providerName, read);
      }
      const mode = providerConfig.mode ?? "json";
      const resolved = new Map<string, unknown>();
      if (mode === "singleValue") {
        for (const ref of refs) {
          if (ref.id !== SINGLE_VALUE_FILE_REF_ID) {
            onRefError(
              refResolutionError({
                code: "SECRET_REF_INVALID",
                source: "file",
                provider: providerName,
                refId: ref.id,
                message: `singleValue file provider "${providerName}" expects ref id "${SINGLE_VALUE_FILE_REF_ID}".`,
              }),
            );
            continue;
          }
          resolved.set(ref.id, payload);
        }
        return resolved;
      }
      for (const ref of refs) {
        try {
          resolved.set(ref.id, readJsonPointer(payload, ref.id, { onMissing: "throw" }));
        } catch (err) {
          // File ref ids are validated before provider dispatch, so pointer failures here mean the
          // requested value is absent rather than the SecretRef contract being malformed.
          onRefError(
            refResolutionError({
              code: "SECRET_REF_NOT_FOUND",
              source: "file",
              provider: providerName,
              refId: ref.id,
              message: formatErrorMessage(err),
              cause: err,
            }),
          );
        }
      }
      return resolved;
    }
    if (providerConfig.source === "store") {
      return await resolveStoreRefs({
        refs,
        providerName,
        onRefError,
        database: { env: options.env ?? process.env },
      });
    }
    if (providerConfig.source === "exec") {
      if (isPluginIntegrationSecretProviderConfig(providerConfig)) {
        throw providerResolutionError({
          source,
          provider: providerName,
          message: `Secret provider "${providerName}" plugin integration was not materialized before exec resolution.`,
        });
      }
      const env = options.env ?? process.env;
      const ids = uniqueStrings(refs.map((ref) => ref.id));
      const secureCommandPath = await assertSecureExecCommandPath({
        command: providerConfig.command,
        label: `secrets.providers.${providerName}.command`,
        trustedDirs: providerConfig.trustedDirs,
      });

      const input = JSON.stringify({
        protocolVersion: 1,
        provider: providerName,
        ids,
      });
      if (Buffer.byteLength(input, "utf8") > DEFAULT_MAX_BATCH_BYTES) {
        throw providerResolutionError({
          code: "SECRET_PROVIDER_INVALID",
          source: "exec",
          provider: providerName,
          message: `Exec provider "${providerName}" request exceeded maxBatchBytes (${DEFAULT_MAX_BATCH_BYTES}).`,
        });
      }

      const childEnv: NodeJS.ProcessEnv = {};
      for (const key of providerConfig.passEnv ?? []) {
        const value = env[key];
        if (value !== undefined) {
          childEnv[key] = value;
        }
      }
      for (const [key, value] of Object.entries(providerConfig.env ?? {})) {
        childEnv[key] = value;
      }

      const timeoutMs = normalizePositiveTimerMs(providerConfig.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
      const noOutputTimeoutMs = normalizePositiveTimerMs(
        providerConfig.noOutputTimeoutMs,
        timeoutMs,
      );
      const maxOutputBytes = normalizePositiveInt(
        providerConfig.maxOutputBytes,
        DEFAULT_EXEC_MAX_OUTPUT_BYTES,
      );
      const jsonOnly = providerConfig.jsonOnly ?? true;

      const result = await runCommandWithTimeout(
        [secureCommandPath, ...(providerConfig.args ?? [])],
        {
          baseEnv: {},
          cwd: path.dirname(secureCommandPath),
          env: childEnv,
          input,
          killProcessTree: true,
          maxCombinedOutputBytes: maxOutputBytes,
          maxOutputBytes,
          noOutputTimeoutMs,
          outputCapture: "head",
          terminateOnOutputLimit: true,
          timeoutMs,
        },
      );
      let failure: string | undefined;
      if (result.termination === "timeout") {
        failure = `Exec provider "${providerName}" timed out after ${timeoutMs}ms.`;
      } else if (result.termination === "no-output-timeout") {
        failure = `Exec provider "${providerName}" produced no output for ${noOutputTimeoutMs}ms.`;
      } else if (result.outputLimitExceeded) {
        failure = `Exec provider output exceeded maxOutputBytes (${maxOutputBytes}).`;
      } else if (result.code !== 0) {
        failure = `Exec provider "${providerName}" exited with code ${String(result.code)}.`;
      }
      if (failure !== undefined) {
        throw providerResolutionError({
          source: "exec",
          provider: providerName,
          message: failure,
        });
      }

      function invalidResponse(detail: string): never {
        throw providerResolutionError({
          source: "exec",
          provider: providerName,
          message: `Exec provider "${providerName}" ${detail}`,
        });
      }
      const trimmed = result.stdout.trim();
      if (!trimmed) {
        invalidResponse("returned empty stdout.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        if (!jsonOnly && ids.length === 1) {
          return new Map([[expectDefined(ids[0], "ids entry at 0"), trimmed]]);
        }
        invalidResponse("returned invalid JSON.");
      }

      if (!isRecord(parsed)) {
        if (!jsonOnly && ids.length === 1 && typeof parsed === "string") {
          return new Map([[expectDefined(ids[0], "ids entry at 0"), parsed]]);
        }
        invalidResponse("response must be an object.");
      }
      if (parsed.protocolVersion !== 1) {
        invalidResponse("protocolVersion must be 1.");
      }
      const responseValues = parsed.values;
      if (!isRecord(responseValues)) {
        invalidResponse('response missing "values".');
      }
      const responseErrors = isRecord(parsed.errors) ? parsed.errors : null;
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        if (responseErrors && Object.hasOwn(responseErrors, id)) {
          const entry = responseErrors[id];
          const code = isRecord(entry) && typeof entry.code === "string" ? entry.code : null;
          const safeCode = code && SAFE_EXEC_ERROR_CODES.has(code) ? code : null;
          onRefError(
            refResolutionError({
              code: safeCode === "NOT_FOUND" ? "SECRET_REF_NOT_FOUND" : "SECRET_REF_PROVIDER_ERROR",
              source: "exec",
              provider: providerName,
              refId: id,
              message: `Exec provider "${providerName}" failed for id "${id}"${safeCode ? ` (${safeCode})` : ""}.`,
            }),
          );
          continue;
        }
        if (!Object.hasOwn(responseValues, id)) {
          onRefError(
            refResolutionError({
              code: "SECRET_REF_NOT_FOUND",
              source: "exec",
              provider: providerName,
              refId: id,
              message: `Exec provider "${providerName}" response missing id "${id}".`,
            }),
          );
          continue;
        }
        out[id] = responseValues[id];
      }
      return new Map(Object.entries(out));
    }
    throw providerResolutionError({
      source,
      provider: providerName,
      message: `Unsupported secret provider source "${String((providerConfig as { source?: unknown }).source)}".`,
    });
  } catch (err) {
    if (isSecretResolutionError(err)) {
      throw err;
    }
    // fs-safe 0.5 exposes one fail-closed receipt for failed permission inspection,
    // unavailable ACL data, and indeterminate owner trust. Keep the diagnostic path-free.
    const isWindowsPathSecurityFailure =
      process.platform === "win32" &&
      (source === "file" || source === "exec") &&
      err instanceof FsSafeError &&
      err.code === "permission-unverified";
    throw providerResolutionError({
      ...(isWindowsPathSecurityFailure
        ? { code: "SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE" as const }
        : {}),
      source,
      provider: providerName,
      message: formatErrorMessage(err),
      cause: err,
    });
  }
}

async function resolveProviderRefGroup(params: {
  group: ProviderRefGroup;
  refs: SecretRef[];
  errorMode: "continue" | "stop";
  options: ResolveSecretRefOptions;
}): Promise<ProviderRefGroupResult> {
  const { group, refs } = params;
  if (group.refs.length > DEFAULT_MAX_REFS_PER_PROVIDER) {
    throw providerResolutionError({
      code: "SECRET_PROVIDER_INVALID",
      source: group.source,
      provider: group.providerName,
      message: `Secret provider "${group.providerName}" exceeded maxRefsPerProvider (${DEFAULT_MAX_REFS_PER_PROVIDER}).`,
    });
  }
  const refFailures = new Map<string, Parameters<SecretRefErrorHandler>[0]>();
  const onRefError: SecretRefErrorHandler = (error) => {
    if (params.errorMode === "stop") {
      throw error;
    }
    refFailures.set(error.refId, error);
  };
  const providerConfig = resolveConfiguredProvider({
    ref: expectDefined(refs[0], "refs entry at 0"),
    config: params.options.config,
    env: params.options.env ?? process.env,
    manifestRegistry: params.options.manifestRegistry,
  });
  const values = await resolveProviderRefs({
    refs,
    source: group.source,
    providerName: group.providerName,
    providerConfig,
    options: params.options,
    onRefError,
  });
  for (const ref of refs) {
    if (refFailures.has(ref.id)) {
      continue;
    }
    if (!values.has(ref.id)) {
      onRefError(
        refResolutionError({
          code: "SECRET_REF_PROVIDER_CONTRACT",
          source: group.source,
          provider: group.providerName,
          refId: ref.id,
          message: `Secret provider "${group.providerName}" did not return id "${ref.id}".`,
        }),
      );
      continue;
    }
    if (isRedactedSecretValue(values.get(ref.id))) {
      onRefError(
        refResolutionError({
          code: "SECRET_REF_REDACTED_VALUE",
          source: group.source,
          provider: group.providerName,
          refId: ref.id,
          message: `Secret reference "${group.source}:${group.providerName}:${ref.id}" resolves to a redaction placeholder. Run openclaw doctor --fix to repair a store-backed Gateway token; supply a real credential for other secrets.`,
        }),
      );
    }
  }
  return { group, values, refFailures };
}

async function resolveSecretRefProviderGroups(params: {
  refs: SecretRef[];
  options: ResolveSecretRefOptions;
  errorMode: "continue" | "stop";
}) {
  return await resolveProviderGroups({
    refs: params.refs,
    errorMode: params.errorMode,
    limit: DEFAULT_PROVIDER_CONCURRENCY,
    resolveGroup: (group, errorMode) => {
      const resolveBatch = (refs: SecretRef[], batchErrorMode = errorMode) =>
        resolveProviderRefGroup({
          group,
          refs,
          errorMode: batchErrorMode,
          options: params.options,
        });
      const cache = params.options.cache
        ? (params.options.cache.resolvedByRefKey ??= new Map())
        : undefined;
      if (cache) {
        return resolveProviderRefGroupWithCache({
          group,
          errorMode,
          cache,
          resolveBatch: (refs) => resolveBatch(refs, "continue"),
        });
      }
      return resolveBatch(group.refs);
    },
  });
}

/** Resolves a batch of SecretRefs, grouped by provider for bounded provider concurrency. */
export async function resolveSecretRefValues(
  refs: SecretRef[],
  options: ResolveSecretRefOptions,
): Promise<Map<string, unknown>> {
  const result = await resolveSecretRefProviderGroups({ refs, options, errorMode: "stop" });
  if (result.hasError) {
    throw result.firstError;
  }
  return result.resolved;
}

/** Internal owner-isolation resolver that preserves one provider call per batch. */
export async function resolveSecretRefValuesSettledByProvider(
  refs: SecretRef[],
  options: ResolveSecretRefOptions,
) {
  const result = await resolveSecretRefProviderGroups({ refs, options, errorMode: "continue" });
  return { resolved: result.resolved, failures: result.failures };
}

/** Resolves one SecretRef, using the optional shared runtime cache. */
export async function resolveSecretRefValue(
  ref: SecretRef,
  options: ResolveSecretRefOptions,
): Promise<unknown> {
  const key = secretRefKey(ref);
  const resolved = await resolveSecretRefValues([ref], options);
  if (!resolved.has(key)) {
    throw refResolutionError({
      code: "SECRET_REF_PROVIDER_CONTRACT",
      source: ref.source,
      provider: ref.provider,
      refId: ref.id,
      message: `Secret reference "${key}" resolved to no value.`,
    });
  }
  return resolved.get(key);
}

/** Resolves one SecretRef and requires a non-empty string result. */
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
