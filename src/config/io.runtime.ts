import fs from "node:fs";
import {
  readDeferredPluginMigrations,
  readDeferredPluginMigrationsAsync,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { loadDotEnvAsync } from "../infra/dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import {
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnvBase,
  prepareConfigRuntimeEnvLoad,
  type PreparedConfigRuntimeEnv,
} from "./config-env-vars.js";
import { resolveManagedUnsetPathsForWrite } from "./config-path-mutation.js";
import { assertConfigWriteAllowedInCurrentMode } from "./config-write-guard.js";
import { resolveWriteEnvSnapshotForPath } from "./env-preserve.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import { createConfigIO } from "./io.factory.js";
import { replaceEnvSnapshot } from "./io.read-helpers.js";
import { createManagedRuntimeEnvBase } from "./io.runtime-env.js";
import { finalizeCommittedConfigWrite } from "./io.runtime-write-finalization.js";
import type {
  BestEffortConfigSnapshot,
  ConfigSnapshotReadOptions,
  ConfigSnapshotMetadataReadOptions,
  ConfigWriteNotification,
  ConfigWriteOptions,
  ConfigWriteResult,
  ReadConfigFileSnapshotForWriteResult,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.types.js";
import { ConfigRuntimeRefreshError } from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { CapturedRuntimeConfigRead } from "./runtime-config-capture-state.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotRefreshHandler,
  getRuntimeConfigSourceSnapshot,
  hasManagedRuntimeConfigWriteOwner,
  loadPinnedRuntimeConfig,
  loadPinnedRuntimeConfigAsync,
  preflightManagedRuntimeConfigWrite,
  preflightRuntimeSnapshotWrite,
  registerManagedRuntimeConfigWriteOwner,
  registerRuntimeConfigWriteListener,
  type RuntimeConfigSnapshotRefreshOptions,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import { projectLegacyRuntimeConfigWrite } from "./runtime-source-projection.js";
import { copyRuntimeConfigWriteApplication } from "./runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "./write-lock.js";

export { createConfigIO };

export function clearConfigCache(): void {
  // Compat shim: runtime snapshot is the only in-process cache now.
}

export function registerConfigWriteListener(
  listener: (event: ConfigWriteNotification) => void,
  options: {
    ownsRuntimeActivationFor?: string;
    prepareSnapshot?: Parameters<typeof registerManagedRuntimeConfigWriteOwner>[2];
    preCommitRuntimePreflight?: (
      sourceConfig: OpenClawConfig,
      refreshOptions?: RuntimeConfigSnapshotRefreshOptions,
    ) => Promise<RuntimeConfigWritePreparedCandidate>;
  } = {},
): () => void {
  const unregisterOwner = options.ownsRuntimeActivationFor
    ? registerManagedRuntimeConfigWriteOwner(
        options.ownsRuntimeActivationFor,
        options.preCommitRuntimePreflight,
        options.prepareSnapshot,
      )
    : undefined;
  const unregisterListener = registerRuntimeConfigWriteListener((event) => {
    const {
      preparedCandidate: _preparedCandidate,
      preparedCandidatesByOwner: _preparedCandidatesByOwner,
      ...baseEvent
    } = event;
    const preparedCandidate = unregisterOwner
      ? event.preparedCandidatesByOwner?.get(unregisterOwner.ownerId)
      : undefined;
    listener(
      copyRuntimeConfigWriteApplication(event, {
        ...baseEvent,
        ...(preparedCandidate ? { preparedCandidate } : {}),
      }),
    );
  });
  return () => {
    unregisterListener();
    unregisterOwner?.();
  };
}

export function loadConfig(options?: {
  skipPluginValidation?: boolean;
  pin?: boolean;
  skipShellEnvFallback?: boolean;
}): OpenClawConfig {
  const loadFresh = () =>
    createConfigIO({
      ...(options?.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
      ...(options?.skipShellEnvFallback ? { shellEnvFallback: "defer" as const } : {}),
    }).loadConfig();
  return options?.pin === false ? loadFresh() : loadPinnedRuntimeConfig(loadFresh);
}

export function getRuntimeConfig(options?: Parameters<typeof loadConfig>[0]): OpenClawConfig {
  return loadConfig(options);
}

type RuntimeConfigAsyncReader<T> = (() => Promise<T>) & { assertCurrent: () => void };

/** Capture the config source before a task read, and load only if its owner needs config facts. */
export function captureRuntimeConfigAsyncReader(options: {
  assertCurrent?: () => void;
  capture: true;
}): RuntimeConfigAsyncReader<CapturedRuntimeConfigRead>;
export function captureRuntimeConfigAsyncReader(options?: {
  assertCurrent?: () => void;
  capture?: false;
}): RuntimeConfigAsyncReader<OpenClawConfig>;
export function captureRuntimeConfigAsyncReader(
  options: { assertCurrent?: () => void; capture?: boolean } = {},
): RuntimeConfigAsyncReader<OpenClawConfig | CapturedRuntimeConfigRead> {
  const sourceEnv = process.env;
  const cwd = tryProcessCwd();
  const readSelectors = () =>
    new Map([...GATEWAY_CONFIG_SELECTION_ENV_KEYS].map((key) => [key, sourceEnv[key]]));
  let selectors = readSelectors();
  const stage = prepareConfigRuntimeEnvLoad({ previousConfig: {} });
  // Legacy cold IO chooses the root config path before dotenv changes the environment.
  const io = createConfigIO({ env: stage.env });
  const assertCurrent = () => {
    options.assertCurrent?.();
    if (
      process.env !== sourceEnv ||
      tryProcessCwd() !== cwd ||
      [...selectors].some(([key, value]) => sourceEnv[key] !== value)
    ) {
      throw new Error("Runtime config source changed during asynchronous preparation");
    }
  };
  const preparePublication = (prepared: PreparedConfigRuntimeEnv): PreparedConfigRuntimeEnv => ({
    env: prepared.env,
    publish: () => {
      assertCurrent();
      const previousSelectors = selectors;
      const publication = prepared.publish();
      // Only this canonical publication may advance the captured selector facts.
      selectors = readSelectors();
      return Object.assign(
        () => {
          publication();
          selectors = previousSelectors;
        },
        { commit: () => publication.commit() },
      );
    },
  });
  let pending: Promise<OpenClawConfig | CapturedRuntimeConfigRead> | undefined;
  const read = () => {
    assertCurrent();
    const loadFresh = async (assertPinned: () => void) => {
      try {
        assertPinned();
        try {
          await loadDotEnvAsync({ env: stage.env, quiet: true, cwd });
        } finally {
          stage.captureDotEnvBaseline();
        }
        assertPinned();
        const config = await io.loadConfigAsync({ assertCurrent: assertPinned });
        assertPinned();
        return { config, runtimeEnv: preparePublication(stage.prepare(config)) };
      } catch (error) {
        assertPinned();
        const publication = preparePublication(stage.prepareFailure()).publish();
        publication.commit();
        throw error;
      }
    };
    return (pending ??= options.capture
      ? loadPinnedRuntimeConfigAsync(loadFresh, { assertCurrent, capture: true })
      : loadPinnedRuntimeConfigAsync(loadFresh, { assertCurrent }));
  };
  return Object.assign(read, { assertCurrent });
}

function createCurrentConfigReader(params: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
}) {
  return createConfigIO({
    configPath: params.configPath,
    env: cloneEnvWithPlatformSemantics(params.env ?? process.env),
    observe: false,
    pluginValidation: "core-only",
    deferredPluginMigrations: params.deferredPluginMigrations,
    shellEnvFallback: "defer",
    suppressFutureVersionWarning: true,
    logger: { warn: () => {}, error: () => {} },
  });
}

/** Inspection may degrade location selection; it never admits invalid config for state repairs. */
export function readCurrentConfigForResolution(
  params: { config?: OpenClawConfig; configPath?: string; env?: NodeJS.ProcessEnv } = {},
): {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  configDiagnostics: BestEffortConfigSnapshot["configDiagnostics"];
} {
  if (params.config) {
    return { config: params.config, env: params.env ?? process.env, configDiagnostics: null };
  }
  const io = createCurrentConfigReader(params);
  let config: OpenClawConfig | undefined;
  try {
    const loaded = io.loadConfig({ skipSuspiciousRecovery: true });
    if (fs.existsSync(io.configPath)) {
      config = loaded;
    }
  } catch {
    // Directory inspection preserves access even when the config cannot be loaded.
  }
  const issues = config
    ? []
    : [
        {
          path: io.configPath,
          message: "Config unavailable; using environment and default agent directory settings.",
        },
      ];
  logConfigWarningsOnce({
    configPath: `${io.configPath}#directory-resolution`,
    warnings: issues,
    logger: console,
  });
  return {
    config: config ?? {},
    env: io.env,
    configDiagnostics: config ? null : { path: io.configPath, issues },
  };
}

/** Revalidate disk policy at a synchronous effect boundary without observing or repairing state. */
export function readCurrentConfigForPolicyCheck(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
}): OpenClawConfig {
  return createCurrentConfigReader({
    ...params,
    deferredPluginMigrations: readDeferredPluginMigrations({ env: params.env }),
  }).loadConfig({ skipSuspiciousRecovery: true });
}

/** Await fresh migration facts for this read; retained synchronous guards use their own boundary. */
export async function readCurrentConfigForPolicyCheckAsync(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<OpenClawConfig> {
  const configPath = params.configPath;
  const env = cloneEnvWithPlatformSemantics(params.env);
  const deferredPluginMigrations = await readDeferredPluginMigrationsAsync({ env });
  return await createCurrentConfigReader({
    configPath,
    env,
    deferredPluginMigrations,
  }).loadConfigAsync({ skipSuspiciousRecovery: true });
}

export async function readBestEffortConfig(options?: {
  isolateEnv?: boolean;
  observe?: boolean;
  skipPluginValidation?: boolean;
  pluginValidation?: ConfigSnapshotReadOptions["pluginValidation"];
}): Promise<OpenClawConfig> {
  return await createConfigIO({
    ...(options?.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options?.observe === false ? { observe: false } : {}),
    pluginValidation:
      options?.pluginValidation ?? (options?.skipPluginValidation ? "skip" : undefined),
  }).readBestEffortConfig();
}

export async function readBestEffortConfigSnapshot(options?: {
  observe?: boolean;
  skipPluginValidation?: boolean;
}): Promise<BestEffortConfigSnapshot> {
  return await createConfigIO({
    ...(options?.observe === false ? { observe: false } : {}),
    ...(options?.skipPluginValidation ? { pluginValidation: "skip" } : {}),
  }).readBestEffortConfigSnapshot();
}

export async function readSourceConfigBestEffort(): Promise<OpenClawConfig> {
  return await createConfigIO().readSourceConfigBestEffort();
}

export async function readConfigFileSnapshot(
  options: ConfigSnapshotReadOptions = {},
): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    deferredPluginMigrations: options.deferredPluginMigrations,
    measure: options.measure,
    observe: options.observe === false ? false : undefined,
    env: options.isolateEnv ? cloneEnvWithPlatformSemantics(process.env) : undefined,
    lowerPrecedenceEnv: options.lowerPrecedenceEnv,
    pluginValidation:
      options.pluginValidation ?? (options.skipPluginValidation ? "skip" : undefined),
    suppressFutureVersionWarning: options.suppressFutureVersionWarning || undefined,
    preservedLegacyRootKeys: options.preservedLegacyRootKeys,
  }).readConfigFileSnapshot({
    recoverSuspicious: options.recoverSuspicious === true,
    allowSuspiciousRecovery: options.allowSuspiciousRecovery,
  });
}

export async function readConfigFileSnapshotWithPluginMetadata(
  options?: Pick<
    ConfigSnapshotMetadataReadOptions,
    | "allowCurrentPluginMetadata"
    | "deferredPluginMigrations"
    | "allowSuspiciousRecovery"
    | "isolateEnv"
    | "lowerPrecedenceEnv"
    | "measure"
    | "observe"
    | "prepareValidation"
    | "recoverSuspicious"
    | "skipPluginValidation"
  >,
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  return await createConfigIO({
    deferredPluginMigrations: options?.deferredPluginMigrations,
    measure: options?.measure,
    observe: options?.observe === false ? false : undefined,
    env: options?.isolateEnv ? cloneEnvWithPlatformSemantics(process.env) : undefined,
    lowerPrecedenceEnv: options?.lowerPrecedenceEnv,
    pluginValidation: options?.skipPluginValidation ? "skip" : undefined,
  }).readConfigFileSnapshotWithPluginMetadata({
    prepareValidation: options?.prepareValidation,
    allowCurrentPluginMetadata: options?.allowCurrentPluginMetadata,
    recoverSuspicious: options?.recoverSuspicious === true,
    allowSuspiciousRecovery: options?.allowSuspiciousRecovery,
  });
}

export async function promoteConfigSnapshotToLastKnownGood(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().promoteConfigSnapshotToLastKnownGood(snapshot);
}

export async function recoverConfigFromLastKnownGood(params: {
  snapshot: ConfigFileSnapshot;
  reason: string;
}): Promise<boolean> {
  return await createConfigIO().recoverConfigFromLastKnownGood(params);
}

export async function recoverConfigFromJsonRootSuffix(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().recoverConfigFromJsonRootSuffix(snapshot);
}

export async function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot> {
  return await readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForRuntimeTransaction(
  activeSourceConfig: OpenClawConfig,
): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    env: createConfigRuntimeEnvBase(activeSourceConfig, process.env, {
      preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
    }),
  }).readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(options?: {
  skipPluginValidation?: boolean;
  observe?: boolean;
}): Promise<ReadConfigFileSnapshotForWriteResult> {
  const readOptions = {
    ...(options?.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
    ...(options?.observe === false ? { observe: false } : {}),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const processIo = createConfigIO(readOptions);
      const io = hasManagedRuntimeConfigWriteOwner(processIo.configPath)
        ? createConfigIO({ ...readOptions, env: createManagedRuntimeEnvBase() })
        : processIo;
      const result = await io.readConfigFileSnapshotForWrite();
      result.writeOptions.assertConfigPathForWrite?.();
      return result;
    } catch (error) {
      if (!(error instanceof ConfigMutationConflictError) || error.retryable || attempt === 2) {
        throw error;
      }
    }
  }
  throw new Error("unreachable");
}

export async function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<ConfigWriteResult> {
  options.assertConfigPathForWrite?.();
  const ioOptions = {
    ...(options.ownedConfigPathForWrite ? { configPath: options.ownedConfigPathForWrite } : {}),
    ...(options.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
    ...(options.observe === false ? { observe: false } : {}),
    ...(options.preservedLegacyRootKeys
      ? { preservedLegacyRootKeys: options.preservedLegacyRootKeys }
      : {}),
  };
  const processIo = createConfigIO(ioOptions);
  return await withConfigWriteLock(
    processIo.configPath,
    async () => {
      options.assertConfigPathForWrite?.();
      const deferRuntimeActivation = hasManagedRuntimeConfigWriteOwner(processIo.configPath);
      const io = deferRuntimeActivation
        ? createConfigIO({ ...ioOptions, env: createManagedRuntimeEnvBase() })
        : processIo;
      assertConfigWriteAllowedInCurrentMode({ configPath: io.configPath });
      const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
      const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
      const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
      const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
      // Snapshot-based inputs retain their own source/runtime basis in the file writer.
      let nextCfg =
        options.inputBase === undefined
          ? projectLegacyRuntimeConfigWrite(cfg, runtimeConfigSnapshot, runtimeConfigSourceSnapshot)
          : cfg;
      const baseSnapshotRead = options.baseSnapshot
        ? {
            snapshot: options.baseSnapshot,
            pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
          }
        : await io.readConfigFileSnapshotWithPluginMetadata();
      const baseSnapshot = baseSnapshotRead.snapshot;
      if (deferRuntimeActivation) {
        replaceEnvSnapshot(io.env, createManagedRuntimeEnvBase());
      }
      let runtimePreflightResult: unknown;
      let managedPreparedCandidates = new Map<symbol, RuntimeConfigWritePreparedCandidate>();
      // Finalization outlives the nested factory lock. Its compensation keeps
      // this original outer owner, never the closed factory scope or a later owner.
      const assertPostCommitCurrent = captureConfigWriteLockGuard(io.configPath);
      const writeResult = await io.writeConfigFile(nextCfg, {
        // Preserve caller policy and provenance; runtime-owned fields take precedence below.
        ...options,
        baseSnapshot,
        basePluginMetadataSnapshot: baseSnapshotRead.pluginMetadataSnapshot,
        envSnapshotForRestore: resolveWriteEnvSnapshotForPath({
          actualConfigPath: io.configPath,
          expectedConfigPath: options.expectedConfigPath,
          envSnapshotForRestore: options.envSnapshotForRestore,
        }),
        unsetPaths: resolveManagedUnsetPathsForWrite(options.unsetPaths),
        explicitSetValueSource: options.explicitSetPaths
          ? (options.explicitSetValueSource ?? cfg)
          : undefined,
        preCommitRuntimePreflight: async (sourceConfig) => {
          // A failed canonical reread must retain the actual resolved write payload,
          // including writer metadata, rather than the caller's runtime-shaped input.
          nextCfg = sourceConfig;
          if (deferRuntimeActivation) {
            managedPreparedCandidates = await preflightManagedRuntimeConfigWrite(
              io.configPath,
              sourceConfig,
              options.runtimeRefresh,
            );
          } else {
            runtimePreflightResult = await preflightRuntimeSnapshotWrite({
              nextSourceConfig: sourceConfig,
              refreshOptions: options.runtimeRefresh,
              formatRefreshError: (error) => formatErrorMessage(error),
              createRefreshError: (detail, cause) =>
                new ConfigRuntimeRefreshError(
                  `Config write blocked before committing ${io.configPath}: active SecretRef resolution failed: ${detail}`,
                  { cause },
                ),
            });
          }
          await options.preCommitRuntimePreflight?.(sourceConfig);
        },
      });
      if (
        options.skipRuntimeSnapshotRefresh &&
        !hadRuntimeSnapshot &&
        !getRuntimeConfigSnapshotRefreshHandler()
      ) {
        return writeResult;
      }
      if (deferRuntimeActivation) {
        replaceEnvSnapshot(io.env, createManagedRuntimeEnvBase());
      }
      return await finalizeCommittedConfigWrite({
        io,
        ioOptions,
        options,
        nextCfg,
        writeResult,
        baseSnapshot,
        hadBothSnapshots,
        deferRuntimeActivation,
        runtimePreflightResult,
        managedPreparedCandidates,
        assertPostCommitCurrent,
      });
    },
    processIo.env,
    options.assertCurrent,
  );
}
