// Prepared plugin runtime load facts and registry-owned context access.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { createSubsystemLogger } from "../../logging.js";
import { isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";
import { normalizePluginsConfig } from "../config-state.js";
import { hashStableJson } from "../installed-plugin-index-hash.js";
import { resolvePluginRegistrationConfigKey } from "../loader-registration-config.js";
import type { PluginLoadOptions } from "../loader-types.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import { resolvePluginControlPlaneFingerprint } from "../plugin-control-plane-context.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { buildDeclaredProviderOwnerIndex } from "../provider-owner-index.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginLogger } from "../types.js";
import {
  bindPluginRuntimeLoadContextState,
  getPluginRuntimeLoadContextState,
  type PluginRuntimeLoadContextState,
} from "./load-context-state.js";

const log = createSubsystemLogger("plugins");

/** Resolved plugin runtime load context shared by runtime loader callers. */
export type PluginRuntimeLoadContext = {
  rawConfig: OpenClawConfig;
  config: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  workspaceDir: string | undefined;
  env: NodeJS.ProcessEnv;
  logger: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  installRecords?: Record<string, PluginInstallRecord>;
  preferBuiltPluginArtifacts?: boolean;
  expectedSourceDigests?: PluginLoadOptions["expectedSourceDigests"];
};

const immutableActivationValueHashes = new WeakMap<object, string>();

function activationValueFingerprint(value: unknown): string {
  const immutable = value !== null && typeof value === "object" && isDeeplyFrozenPlainData(value);
  const cached = immutable ? immutableActivationValueHashes.get(value) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = hashStableJson(value);
  if (immutable) {
    immutableActivationValueHashes.set(value, fingerprint);
  }
  return fingerprint;
}

function activationConfigFingerprint(config: OpenClawConfig): string {
  // Auto-enable replaces the plugin policy but carries the immutable fleet/model trees.
  return hashStableJson(
    Object.fromEntries(
      Object.entries(config).map(([key, value]) => [key, activationValueFingerprint(value)]),
    ),
  );
}

function activationInputFingerprint(config: OpenClawConfig, env: NodeJS.ProcessEnv): string {
  return hashStableJson({ config: activationConfigFingerprint(config), env });
}

function activationResultFingerprint(context: PluginRuntimeLoadContext): string {
  return hashStableJson({
    config: activationConfigFingerprint(context.config),
    activationSourceConfig: activationConfigFingerprint(context.activationSourceConfig),
    autoEnabledReasons: context.autoEnabledReasons,
    env: context.env,
  });
}

export function setPluginRuntimeLoadContext(
  registry: PluginRegistry,
  context: PluginRuntimeLoadContext,
  registrationConfigKey?: string,
  loaderCacheIdentity?: PluginRuntimeLoadContextState["loaderCacheIdentity"],
): void {
  const previous = getPluginRuntimeLoadContextState(registry);
  const capturedIdentity = previous?.loaderCacheIdentity ?? loaderCacheIdentity;
  const bound = {
    ...context,
    activationInputFingerprint: activationInputFingerprint(context.rawConfig, context.env),
    activationResultFingerprint: activationResultFingerprint(context),
    ...(capturedIdentity ? { loaderCacheIdentity: capturedIdentity } : {}),
    // Host preparation may rebind metadata, but it cannot change already-registered closures.
    registrationConfigKey:
      previous?.registrationConfigKey ??
      registrationConfigKey ??
      resolvePluginRegistrationConfigKey({
        runtimeEntries: normalizePluginsConfig(context.config.plugins).entries,
        sourceEntries: normalizePluginsConfig(context.activationSourceConfig.plugins).entries,
      }),
    declaredProviderOwners:
      context.metadataSnapshot &&
      context.metadataSnapshot.manifestRegistry === context.manifestRegistry
        ? context.metadataSnapshot.declaredProviderOwners
        : buildDeclaredProviderOwnerIndex(context.manifestRegistry?.plugins ?? []),
    // Capture selection before caller-owned config or environment objects can change.
    controlPlaneFingerprint: resolvePluginControlPlaneFingerprint({
      config: context.rawConfig,
      env: context.env,
      workspaceDir: context.workspaceDir,
    }),
  };
  bindPluginRuntimeLoadContextState(registry, bound);
}

/** Reads load facts carried by an exact lifecycle-owned registry. */
export const getPluginRuntimeLoadContext = (
  registry: object | undefined,
): (PluginRuntimeLoadContext & PluginRuntimeLoadContextState) | undefined =>
  // SAFETY: setPluginRuntimeLoadContext is the sole writer and supplies all load facts.
  getPluginRuntimeLoadContextState(registry) as
    | (PluginRuntimeLoadContext & PluginRuntimeLoadContextState)
    | undefined;

/** Reuses activation decisions only within the exact metadata generation and unchanged inputs. */
export function getReusablePluginRuntimeActivation(
  registry: object | undefined,
  params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    workspaceDir: string | undefined;
    metadataSnapshot: PluginMetadataSnapshot;
  },
):
  | Pick<PluginRuntimeLoadContext, "config" | "activationSourceConfig" | "autoEnabledReasons">
  | undefined {
  const context = getPluginRuntimeLoadContext(registry);
  if (
    !context ||
    context.metadataSnapshot !== params.metadataSnapshot ||
    context.workspaceDir !== params.workspaceDir ||
    context.activationResultFingerprint !== activationResultFingerprint(context)
  ) {
    return undefined;
  }
  const inputFingerprint = activationInputFingerprint(params.config, params.env);
  // Startup callers can carry either the source config or the already-applied activation config.
  if (
    inputFingerprint !== context.activationInputFingerprint &&
    inputFingerprint !== activationInputFingerprint(context.config, context.env) &&
    inputFingerprint !== activationInputFingerprint(context.activationSourceConfig, context.env)
  ) {
    return undefined;
  }
  return {
    config: context.config,
    activationSourceConfig: context.activationSourceConfig,
    autoEnabledReasons: context.autoEnabledReasons,
  };
}

/** Runtime load option values that can be passed directly to plugin loading. */
type PluginRuntimeResolvedLoadValues = Pick<
  PluginLoadOptions,
  | "config"
  | "activationSourceConfig"
  | "autoEnabledReasons"
  | "workspaceDir"
  | "env"
  | "logger"
  | "manifestRegistry"
  | "installRecords"
  | "preferBuiltPluginArtifacts"
  | "expectedSourceDigests"
>;

/** Creates the default plugin runtime loader logger. */
export function createPluginRuntimeLoaderLogger(): PluginLogger {
  return {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    debug: (message) => log.debug(message),
  };
}

/** Projects explicit runtime load fields from prepared contexts or resolved values. */
export function buildPluginRuntimeLoadOptions(
  values: PluginRuntimeResolvedLoadValues,
  overrides?: Partial<PluginLoadOptions>,
): PluginLoadOptions {
  return {
    config: values.config,
    activationSourceConfig: values.activationSourceConfig,
    autoEnabledReasons: values.autoEnabledReasons,
    workspaceDir: values.workspaceDir,
    env: values.env,
    logger: values.logger,
    manifestRegistry: values.manifestRegistry,
    installRecords: values.installRecords,
    preferBuiltPluginArtifacts: values.preferBuiltPluginArtifacts,
    expectedSourceDigests: values.expectedSourceDigests,
    ...overrides,
  };
}
