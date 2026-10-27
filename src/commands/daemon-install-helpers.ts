import path from "node:path";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import { collectEnvSecretRefIds, resolveConfigSecretRef } from "../config/resolution-facts.js";
import { collectDurableServiceEnvVarSources } from "../config/state-dir-dotenv.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveSecretInputRef, type SecretRef } from "../config/types.secrets.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { resolveLaunchAgentEnvWrapperPath } from "../daemon/launchd-service-files.js";
import { resolveGatewayStateDir, resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import {
  OPENCLAW_WRAPPER_ENV_KEY,
  resolveGatewayProgramArguments,
  resolveOpenClawWrapperPath,
} from "../daemon/program-args.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  formatManagedServiceEnvKeys,
  normalizeServiceEnvKey,
  readEnvironmentValueSource,
  readManagedServiceEnvKeysFromEnvironment,
  writeManagedServiceEnvKeysToEnvironment,
} from "../daemon/service-managed-env.js";
import { mergeServicePath } from "../daemon/service-path-policy.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
  type GatewayServiceEnvironmentValueSource,
} from "../daemon/service-types.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { omitSecretEgressProxyEnvironment } from "../secrets/egress-proxy/environment.js";
import {
  isPluginIntegrationSecretProviderConfig,
  resolveSecretProviderIntegrationConfig,
} from "../secrets/provider-integrations.js";
import { collectPluginConfigAssignments } from "../secrets/runtime-config-collectors-plugins.js";
import { evaluateGatewayAuthSurfaceStates } from "../secrets/runtime-gateway-auth-surfaces.js";
import { hasSecretRefCandidate } from "../secrets/runtime-secret-scan.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import {
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonServicePathDirs,
  type GatewayInstallPlan,
} from "./daemon-install-plan.shared.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

// Gateway ingress secrets must never be newly materialized into supervisor metadata.
// Existing active service values are retained separately during regeneration.
const NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS = new Set([
  "gateway.auth.password",
  "gateway.auth.token",
]);

type ExecSecretRefPassEnvSource = {
  ref: SecretRef;
  warningTitle: "Config SecretRef" | "Auth profile" | "Plugin config SecretRef";
};

function collectAuthProfileSecretRefs(authStore: AuthProfileStore | undefined): SecretRef[] {
  if (!authStore) {
    return [];
  }
  return Object.values(authStore.profiles).flatMap((credential) => {
    const ref =
      credential.type === "api_key"
        ? credential.keyRef
        : credential.type === "token"
          ? credential.tokenRef
          : undefined;
    return ref ? [ref] : [];
  });
}

function* configSecretRefsForService(config: OpenClawConfig) {
  for (const target of discoverConfigSecretTargets(config)) {
    if (!target.entry.includeInPlan) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: resolveConfigSecretRef({
        config,
        path: target.path,
        value: target.value,
        defaults: config.secrets?.defaults,
        includeResolved: true,
      }),
      refValue: target.refValue,
      defaults: config.secrets?.defaults,
    });
    if (ref) {
      yield { target, ref };
    }
  }
}

// Preserve operator opt-ins while discarding stale OpenClaw-managed values.
const PRESERVED_OPENCLAW_OPERATOR_OPT_IN_ENV_KEYS = new Set([
  "OPENCLAW_CLI_CONTAINER_BYPASS",
  "OPENCLAW_CONFIG_READONLY",
  "OPENCLAW_CONTAINER_HINT",
  "OPENCLAW_GATEWAY_STARTUP_TRACE",
]);

function collectExistingServiceEnvVars(
  existingEnvironment: Record<string, string | undefined> | undefined,
  includeKey: (normalizedKey: string) => boolean,
): Record<string, string | undefined> {
  const preserved: Record<string, string | undefined> = {};
  for (const [rawKey, rawValue] of Object.entries(existingEnvironment ?? {})) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (
      !key ||
      !includeKey(key.toUpperCase()) ||
      isDangerousHostEnvVarName(key) ||
      isDangerousHostEnvOverrideVarName(key)
    ) {
      continue;
    }
    const value = rawValue?.trim();
    if (!value) {
      continue;
    }
    preserved[key] = value;
  }
  return preserved;
}

function omitEnvironmentEntriesShadowedBy(
  entries: Record<string, string | undefined>,
  shadowEntries: Array<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const shadowKeys = new Set(
    shadowEntries.flatMap((environment) =>
      Object.keys(environment).flatMap((key) => {
        const normalized = normalizeEnvVarKey(key, { portable: true })?.toUpperCase();
        return normalized ? [normalized] : [];
      }),
    ),
  );
  return Object.fromEntries(
    Object.entries(entries).filter(([key]) => {
      const normalized = normalizeEnvVarKey(key, { portable: true })?.toUpperCase();
      return !normalized || !shadowKeys.has(normalized);
    }),
  );
}

async function buildGatewayInstallEnvironment(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
  warn?: DaemonInstallWarnFn;
  serviceEnvironment: Record<string, string | undefined>;
  existingEnvironment?: Record<string, string | undefined>;
  existingEnvironmentValueSources?: Record<
    string,
    GatewayServiceEnvironmentValueSource | undefined
  >;
  platform: NodeJS.Platform;
}): Promise<{
  environment: Record<string, string | undefined>;
  environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}> {
  const { stateDirDotEnvEnvironment, configEnvironment, durableEnvironment } =
    collectDurableServiceEnvVarSources({
      env: params.env,
      config: params.config,
    });
  // Full target discovery materializes plugin metadata; configs without refs do not need it.
  const containsConfigSecretRef =
    hasSecretRefCandidate(params.config, params.config?.secrets?.defaults) ||
    collectEnvSecretRefIds(params.config).size > 0;
  const secretRefEnvKeys = new Set<string>();
  const configSecretRefEnvironment: Record<string, string> = {};
  {
    const { env, config, warn } = params;
    if (config && containsConfigSecretRef) {
      const gatewayAuthSurfaceStates = evaluateGatewayAuthSurfaceStates({
        config,
        env: env as NodeJS.ProcessEnv,
        defaults: config.secrets?.defaults,
      });
      for (const { target, ref } of configSecretRefsForService(config)) {
        if (ref.source !== "env") {
          continue;
        }
        const key = normalizeEnvVarKey(ref.id, { portable: true });
        if (!key) {
          warn?.(
            `Config SecretRef env id "${ref.id}" is not portable and was not added to the service environment`,
            "Config SecretRef",
          );
          continue;
        }
        if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
          warn?.(
            `Config SecretRef env ref "${key}" blocked by host-env security policy`,
            "Config SecretRef",
          );
          continue;
        }
        if (NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS.has(target.entry.id)) {
          const surface =
            gatewayAuthSurfaceStates[target.entry.id as keyof typeof gatewayAuthSurfaceStates];
          if (surface?.active) {
            secretRefEnvKeys.add(key.toUpperCase());
          }
          continue;
        }
        secretRefEnvKeys.add(key.toUpperCase());
        if (Object.hasOwn(stateDirDotEnvEnvironment, key)) {
          continue;
        }
        const value = env[key]?.trim();
        if (!value) {
          continue;
        }
        configSecretRefEnvironment[key] = value;
      }
    }
  }
  let authStore = params.authStore;
  if (!authStore) {
    // Keep the daemon install cold path cheap when there is no auth store to read.
    const { hasAnyAuthProfileStoreSourceAsync } =
      await import("./daemon-install-auth-profiles-source.runtime.js");
    if (await hasAnyAuthProfileStoreSourceAsync()) {
      const { loadAuthProfileStoreForSecretsRuntimeAsync } =
        await import("./daemon-install-auth-profiles-store.runtime.js");
      authStore = await loadAuthProfileStoreForSecretsRuntimeAsync();
    }
  }
  const execSecretRefPassEnvEnvironment: Record<string, string> = {};
  {
    const { env, config, warn } = params;
    if (config) {
      let manifestRegistry: Pick<PluginManifestRegistry, "plugins"> | undefined;
      const sources: ExecSecretRefPassEnvSource[] = [];
      if (containsConfigSecretRef) {
        for (const { ref } of configSecretRefsForService(config)) {
          if (ref.source === "exec") {
            sources.push({ ref, warningTitle: "Config SecretRef" });
          }
        }
      }
      for (const ref of collectAuthProfileSecretRefs(authStore)) {
        if (ref.source === "exec") {
          sources.push({ ref, warningTitle: "Auth profile" });
        }
      }
      if (containsConfigSecretRef) {
        const context = createResolverContext({
          sourceConfig: config,
          env: env as NodeJS.ProcessEnv,
        });
        collectPluginConfigAssignments({
          config,
          defaults: config.secrets?.defaults,
          context,
        });
        for (const ref of context.assignments.map((assignment) => assignment.ref)) {
          if (ref.source === "exec") {
            sources.push({ ref, warningTitle: "Plugin config SecretRef" });
          }
        }
      }
      for (const { ref, warningTitle } of sources) {
        const provider = config.secrets?.providers?.[ref.provider];
        if (!provider || provider.source !== "exec") {
          continue;
        }
        const execProvider = isPluginIntegrationSecretProviderConfig(provider)
          ? (() => {
              manifestRegistry ??= resolveConfigWidePluginManifestRegistry({
                config,
                env,
              });
              const resolved = resolveSecretProviderIntegrationConfig({
                manifestRegistry,
                providerAlias: ref.provider,
                providerConfig: provider,
                config,
                env,
              });
              if (!resolved.ok) {
                warn?.(
                  `Exec SecretRef plugin provider "${ref.provider}" could not be resolved for service environment planning: ${resolved.reason}`,
                  warningTitle,
                );
                return undefined;
              }
              return resolved.providerConfig;
            })()
          : provider;
        if (!execProvider) {
          continue;
        }
        for (const rawKey of execProvider.passEnv ?? []) {
          const key = normalizeEnvVarKey(rawKey, { portable: true });
          if (!key) {
            warn?.(
              `Exec SecretRef passEnv id "${rawKey}" is not portable and was not added to the service environment`,
              warningTitle,
            );
            continue;
          }
          const value = Object.hasOwn(env, key) ? env[key]?.trim() : undefined;
          if (!value) {
            continue;
          }
          if (
            isDangerousHostEnvVarName(key) ||
            (isDangerousHostEnvOverrideVarName(key) && key.toUpperCase() !== "HOME")
          ) {
            warn?.(
              `Exec SecretRef passEnv ref "${key}" blocked by host-env security policy`,
              warningTitle,
            );
            continue;
          }
          if (Object.hasOwn(durableEnvironment, key)) {
            continue;
          }
          execSecretRefPassEnvEnvironment[key] = value;
        }
      }
    }
  }
  const authProfileEnvironment: Record<string, string> = {};
  for (const ref of collectAuthProfileSecretRefs(authStore)) {
    if (ref.source !== "env") {
      continue;
    }
    const key = normalizeEnvVarKey(ref.id, { portable: true });
    if (!key) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      params.warn?.(
        `Auth profile env ref "${key}" blocked by host-env security policy`,
        "Auth profile",
      );
      continue;
    }
    if (params.platform === "linux") {
      secretRefEnvKeys.add(key.toUpperCase());
    }
    const value = params.env[key]?.trim();
    if (!value) {
      continue;
    }
    authProfileEnvironment[key] = value;
  }
  let ambientProviderApiKeyEnvironment: Record<string, string> = {};
  {
    const { env, config: ambientConfig, existingEnvironment, platform } = params;
    if (platform === "linux") {
      const existingManagedKeys = readManagedServiceEnvKeysFromEnvironment(existingEnvironment);
      const ownedKeys = new Set(
        [
          ...Object.keys(durableEnvironment),
          ...Object.keys(authProfileEnvironment),
          ...Object.entries(existingEnvironment ?? {}).flatMap(([key, value]) =>
            existingManagedKeys.has(key.toUpperCase()) && env[key]?.trim() !== value?.trim()
              ? []
              : [key],
          ),
        ].map((key) => key.toUpperCase()),
      );
      const candidates = new Map(
        Object.entries(env).flatMap(([rawKey, rawValue]) => {
          const key = normalizeEnvVarKey(rawKey, { portable: true })?.toUpperCase();
          const value = rawValue?.trim();
          return key &&
            key.endsWith("_API_KEY") &&
            !key.endsWith("_ADMIN_API_KEY") &&
            !ownedKeys.has(key) &&
            value &&
            !isDangerousHostEnvVarName(key) &&
            !isDangerousHostEnvOverrideVarName(key)
            ? [[key, value] as const]
            : [];
        }),
      );
      if (candidates.size > 0) {
        const { isManifestPluginAvailableForControlPlane, loadManifestMetadataSnapshot } =
          await import("../plugins/manifest-contract-eligibility.js");
        const config = ambientConfig ?? {};
        const snapshot = loadManifestMetadataSnapshot({ config, env });
        ambientProviderApiKeyEnvironment = Object.fromEntries(
          snapshot.plugins.flatMap((plugin) => {
            if (
              (plugin.origin !== "bundled" && plugin.trustedOfficialInstall !== true) ||
              !isManifestPluginAvailableForControlPlane({ snapshot, plugin, config })
            ) {
              return [];
            }
            const providers = new Set(
              (plugin.providerAuthChoices ?? [])
                .filter(
                  ({ method, appGuidedSecret, onboardingScopes }) =>
                    method === "api-key" &&
                    appGuidedSecret === true &&
                    (!onboardingScopes || onboardingScopes.includes("text-inference")),
                )
                .map(({ provider }) => provider),
            );
            return (plugin.setup?.providers ?? [])
              .filter(({ id }) => providers.has(id))
              .flatMap(({ envVars = [] }) =>
                envVars.flatMap((name) => {
                  const key = normalizeEnvVarKey(name, { portable: true })?.toUpperCase();
                  const value = key ? candidates.get(key) : undefined;
                  return key && value ? [[key, value] as const] : [];
                }),
              );
          }),
        );
      }
    }
  }
  const stateDirDotEnvRenderEnvironment = omitEnvironmentEntriesShadowedBy(
    stateDirDotEnvEnvironment,
    [
      configEnvironment,
      configSecretRefEnvironment,
      execSecretRefPassEnvEnvironment,
      authProfileEnvironment,
    ],
  );
  const existingManagedKeys = readManagedServiceEnvKeysFromEnvironment(params.existingEnvironment);
  const preservedExistingEnvironment = collectExistingServiceEnvVars(
    params.existingEnvironment,
    // Like OPENCLAW_SQLITE_LIBRARY, HOMEBREW_PREFIX must regenerate from each install/repair invocation.
    (key) =>
      key !== "HOME" &&
      key !== "PATH" &&
      key !== "TMPDIR" &&
      key !== "HOMEBREW_PREFIX" &&
      (!key.startsWith("OPENCLAW_") || PRESERVED_OPENCLAW_OPERATOR_OPT_IN_ENV_KEYS.has(key)) &&
      !existingManagedKeys.has(key),
  );
  const environment: Record<string, string | undefined> = {};
  const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource | undefined> =
    {};
  function addServiceEnvPlanEntries(
    entries: Record<string, string | undefined>,
    options: {
      includeRawKeys?: boolean;
      includeKeys?: ReadonlySet<string>;
      valueSource?:
        | GatewayServiceEnvironmentValueSource
        | ((params: { normalizedKey: string }) => GatewayServiceEnvironmentValueSource | undefined);
    },
  ): void {
    for (const [rawKey, rawValue] of Object.entries(entries)) {
      if (typeof rawValue !== "string" || !rawValue.trim()) {
        if (options.includeRawKeys) {
          // Preserve explicit blank raw keys only when callers need round-trip
          // visibility in generated service env.
          environment[rawKey] = rawValue;
          environmentValueSources[rawKey] = "inline";
        }
        continue;
      }
      const normalizedKey = normalizeServiceEnvKey(rawKey);
      if (!normalizedKey || (options.includeKeys && !options.includeKeys.has(normalizedKey))) {
        continue;
      }
      environment[rawKey] = rawValue;
      const valueSource =
        typeof options.valueSource === "function"
          ? options.valueSource({ normalizedKey })
          : options.valueSource;
      environmentValueSources[rawKey] = valueSource ?? "inline";
    }
  }
  addServiceEnvPlanEntries(preservedExistingEnvironment, {
    valueSource: ({ normalizedKey }) =>
      readEnvironmentValueSource(params.existingEnvironmentValueSources, normalizedKey) ?? "inline",
  });
  addServiceEnvPlanEntries(ambientProviderApiKeyEnvironment, { valueSource: "file" });
  addServiceEnvPlanEntries(stateDirDotEnvEnvironment, {});
  addServiceEnvPlanEntries(configEnvironment, {});
  addServiceEnvPlanEntries(execSecretRefPassEnvEnvironment, {});
  const secretRefKeyEnvironment = Object.fromEntries(
    [...secretRefEnvKeys].map((key) => [key, "1"]),
  );
  const managedServiceEnvKeys = formatManagedServiceEnvKeys(
    {
      ...durableEnvironment,
      ...secretRefKeyEnvironment,
    },
    { omitKeys: Object.keys(params.serviceEnvironment) },
  );
  const existingSecretRefRenderEnvironment = omitEnvironmentEntriesShadowedBy(
    collectExistingServiceEnvVars(params.existingEnvironment, (key) => secretRefEnvKeys.has(key)),
    [
      stateDirDotEnvRenderEnvironment,
      configSecretRefEnvironment,
      execSecretRefPassEnvEnvironment,
      authProfileEnvironment,
    ],
  );
  const { serviceEnvironment, platform } = params;
  const launchAgent =
    platform === "darwin" && Boolean(serviceEnvironment.OPENCLAW_LAUNCHD_LABEL?.trim());
  writeManagedServiceEnvKeysToEnvironment(environment, managedServiceEnvKeys);
  if (environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS) {
    environmentValueSources.OPENCLAW_SERVICE_MANAGED_ENV_KEYS = "inline";
  }
  // Managed-key replacement clears values; publish credentials after that cleanup.
  addServiceEnvPlanEntries(authProfileEnvironment, {
    valueSource: platform === "linux" ? "file" : "inline",
  });
  const managedKeys = readManagedServiceEnvKeysFromEnvironment({
    OPENCLAW_SERVICE_MANAGED_ENV_KEYS: managedServiceEnvKeys,
  });
  if (managedKeys.size > 0) {
    // Preserve installed values for active SecretRefs, migrating legacy inline values
    // into the supervisor's owner-only env file before the service is rewritten.
    if (launchAgent || platform === "linux") {
      addServiceEnvPlanEntries(existingSecretRefRenderEnvironment, {
        includeKeys: managedKeys,
        valueSource: "file",
      });
    }
    if (launchAgent) {
      addServiceEnvPlanEntries(stateDirDotEnvRenderEnvironment, {
        includeKeys: managedKeys,
        valueSource: "inline",
      });
    }
    addServiceEnvPlanEntries(configSecretRefEnvironment, {
      includeKeys: managedKeys,
      valueSource: platform === "linux" ? "file" : "inline",
    });
  }
  addServiceEnvPlanEntries(params.serviceEnvironment, {
    includeRawKeys: true,
  });
  const mergedPath = mergeServicePath(
    params.serviceEnvironment.PATH,
    params.existingEnvironment?.PATH,
    params.serviceEnvironment.TMPDIR,
    params.platform,
  );
  if (mergedPath) {
    environment.PATH = mergedPath;
    environmentValueSources.PATH = "inline";
  }
  for (const key of Object.keys(environmentValueSources)) {
    if (!Object.hasOwn(environment, key)) {
      delete environmentValueSources[key];
    }
  }
  return { environment, environmentValueSources };
}

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  allowUnconfigured?: boolean;
  runtime: GatewayDaemonRuntime;
  runtimeExplicit?: boolean;
  existingEnvironment?: Record<string, string | undefined>;
  existingCommand?: GatewayServiceCommandConfig | null;
  devMode?: boolean;
  runtimePath?: string;
  pinnedRuntimePath?: string;
  /** Retained CLI to plan for instead of this process's own entrypoint and executable. */
  serviceCli?: { executable: string; entrypoint: string | null };
  wrapperPath?: string;
  platform?: NodeJS.Platform;
  warn?: DaemonInstallWarnFn;
  /** Full config to extract env vars from (env vars + inline env keys). */
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
  existingEnvironmentValueSources?: Record<
    string,
    GatewayServiceEnvironmentValueSource | undefined
  >;
}): Promise<GatewayInstallPlan> {
  const platform = params.platform ?? process.platform;
  const env = omitSecretEgressProxyEnvironment(params.env, platform);
  const existingEnvironment = omitSecretEgressProxyEnvironment(
    params.existingEnvironment ?? {},
    platform,
  );
  env.NODE_EXTRA_CA_CERTS =
    resolveEnvironmentValue(env, "NODE_EXTRA_CA_CERTS", platform) ??
    resolveEnvironmentValue(existingEnvironment, "NODE_EXTRA_CA_CERTS", platform);
  const wrapperInput = params.wrapperPath ?? env[OPENCLAW_WRAPPER_ENV_KEY];
  const generatedWrapperPath =
    platform === "win32"
      ? resolveGatewayTaskScriptPath(env)
      : platform === "darwin"
        ? resolveLaunchAgentEnvWrapperPath(env, resolveLaunchAgentLabel(env))
        : undefined;
  const wrapperPointsAtGeneratedScript =
    generatedWrapperPath !== undefined &&
    normalizeServicePathForCompare(wrapperInput, platform) ===
      normalizeServicePathForCompare(generatedWrapperPath, platform);
  if (wrapperPointsAtGeneratedScript) {
    params.warn?.(
      platform === "win32"
        ? `Ignoring ${OPENCLAW_WRAPPER_ENV_KEY} because it points to the Windows task script; using the OpenClaw gateway entrypoint directly to avoid a recursive gateway.cmd wrapper.`
        : `Ignoring ${OPENCLAW_WRAPPER_ENV_KEY} because it points to the generated LaunchAgent environment wrapper; using the OpenClaw gateway entrypoint directly to avoid a self-referencing wrapper.`,
    );
  }
  const wrapperPath = wrapperPointsAtGeneratedScript
    ? undefined
    : await resolveOpenClawWrapperPath(wrapperInput);
  const { devMode, runtime, runtimePath } = await resolveDaemonInstallRuntimeInputs({
    env,
    runtime: params.runtime,
    runtimeExplicit: params.runtimeExplicit,
    devMode: params.serviceCli ? false : params.devMode,
    runtimePath: params.runtimePath,
    pinnedRuntimePath: params.pinnedRuntimePath,
    wrapperPath,
    warn: params.warn,
  });
  const serviceInputEnv = { ...env };
  if (wrapperPath) {
    serviceInputEnv[OPENCLAW_WRAPPER_ENV_KEY] = wrapperPath;
  } else if (wrapperPointsAtGeneratedScript) {
    delete serviceInputEnv[OPENCLAW_WRAPPER_ENV_KEY];
  }
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port: params.port,
    allowUnconfigured:
      params.allowUnconfigured ??
      (params.config?.gateway?.mode === "remote" &&
        resolveManagedGatewayServiceCommand(params.existingCommand)?.programArguments.includes(
          "--allow-unconfigured",
        ) === true),
    dev: devMode,
    runtime,
    runtimePath,
    wrapperPath,
    cliEntrypoint: params.serviceCli?.entrypoint ?? undefined,
    ...(params.existingCommand ? { existingCommand: params.existingCommand } : {}),
  });
  await emitNodeRuntimeWarning({
    env,
    runtime,
    nodeProgram: programArguments[0],
    warn: params.warn,
    title: "Gateway runtime",
  });
  const serviceEnvironment = buildServiceEnvironment({
    env: serviceInputEnv,
    execPath: params.serviceCli?.executable,
    port: params.port,
    runtime,
    existingNodeOptions: resolveManagedGatewayServiceCommand(params.existingCommand)?.environment
      ?.NODE_OPTIONS,
    launchdLabel:
      platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(serviceInputEnv.OPENCLAW_PROFILE)
        : undefined,
    platform,
    extraPathDirs: resolveDaemonServicePathDirs({
      runtimePath,
      argv: params.serviceCli && [
        params.serviceCli.executable,
        ...(params.serviceCli.entrypoint ? [params.serviceCli.entrypoint] : []),
      ],
      env: serviceInputEnv,
      platform,
    }),
  });

  const { environment, environmentValueSources } = await buildGatewayInstallEnvironment({
    env: serviceInputEnv,
    config: params.config,
    authStore: params.authStore,
    warn: params.warn,
    serviceEnvironment,
    existingEnvironment,
    existingEnvironmentValueSources: params.existingEnvironmentValueSources,
    platform,
  });

  // Lowest to highest: preserved custom vars, durable config, SecretRef env, generated service env.
  return {
    runtime,
    programArguments,
    workingDirectory:
      workingDirectory ||
      (platform === "darwin" ? resolveGatewayStateDir(serviceInputEnv) : undefined),
    environment,
    ...(Object.keys(environmentValueSources).length > 0 ? { environmentValueSources } : {}),
  };
}

function normalizeServicePathForCompare(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return platform === "win32" ? path.win32.resolve(trimmed).toLowerCase() : path.resolve(trimmed);
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
