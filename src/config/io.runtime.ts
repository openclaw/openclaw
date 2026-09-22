import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { loadDotEnvAsync } from "../infra/dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { recordUpdateDoctorConfigWrite } from "../infra/update-doctor-result.js";
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
import {
  createManagedRuntimeEnvBase,
  hashConfigRaw,
  replaceEnvSnapshot,
  resolveManagedRuntimeEnvBaseline,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
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
import { ConfigRuntimeRefreshError, configWritePostCommitRollback } from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import { ConfigWritePostCommitError, type ConfigWriteRollbackStatus } from "./io.write-errors.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { CapturedRuntimeConfigRead } from "./runtime-config-capture-state.js";
import {
  createRuntimeConfigWriteNotification,
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotRefreshHandler,
  getRuntimeConfigSourceSnapshot,
  hasManagedRuntimeConfigWriteOwner,
  loadPinnedRuntimeConfig,
  loadPinnedRuntimeConfigAsync,
  notifyRuntimeConfigWriteListeners,
  preflightManagedRuntimeConfigWrite,
  preflightRuntimeSnapshotWrite,
  projectRuntimeConfigWritePreparedCandidates,
  registerManagedRuntimeConfigWriteOwner,
  registerRuntimeConfigWriteListener,
  type RuntimeConfigSnapshotRefreshOptions,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import { projectLegacyRuntimeConfigWrite } from "./runtime-source-projection.js";
import {
  attachRuntimeConfigWriteApplication,
  copyRuntimeConfigWriteApplication,
  getRuntimeConfigWriteApplication,
} from "./runtime-write-application.js";
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

export function getRuntimeConfig(options?: {
  skipPluginValidation?: boolean;
  pin?: boolean;
  skipShellEnvFallback?: boolean;
}): OpenClawConfig {
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
  const pluginValidation =
    options.pluginValidation ?? (options.skipPluginValidation ? "skip" : undefined);
  return await createConfigIO({
    ...(options.deferredPluginMigrations
      ? { deferredPluginMigrations: options.deferredPluginMigrations }
      : {}),
    ...(options.measure ? { measure: options.measure } : {}),
    ...(options.observe === false ? { observe: false } : {}),
    ...(options.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options.lowerPrecedenceEnv ? { lowerPrecedenceEnv: options.lowerPrecedenceEnv } : {}),
    ...(pluginValidation ? { pluginValidation } : {}),
    ...(options.suppressFutureVersionWarning ? { suppressFutureVersionWarning: true } : {}),
    ...(options.preservedLegacyRootKeys
      ? { preservedLegacyRootKeys: options.preservedLegacyRootKeys }
      : {}),
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
    ...(options?.deferredPluginMigrations
      ? { deferredPluginMigrations: options.deferredPluginMigrations }
      : {}),
    ...(options?.measure ? { measure: options.measure } : {}),
    ...(options?.observe === false ? { observe: false } : {}),
    ...(options?.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options?.lowerPrecedenceEnv ? { lowerPrecedenceEnv: options.lowerPrecedenceEnv } : {}),
    ...(options?.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
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
        options,
        nextCfg,
        writeResult,
        baseSnapshot,
        hadRuntimeSnapshot,
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

async function finalizeCommittedConfigWrite(params: {
  io: ReturnType<typeof createConfigIO>;
  options: ConfigWriteOptions;
  nextCfg: OpenClawConfig;
  writeResult: Awaited<ReturnType<ReturnType<typeof createConfigIO>["writeConfigFile"]>>;
  baseSnapshot: ConfigFileSnapshot;
  hadRuntimeSnapshot: boolean;
  hadBothSnapshots: boolean;
  deferRuntimeActivation: boolean;
  runtimePreflightResult: unknown;
  managedPreparedCandidates: Map<symbol, RuntimeConfigWritePreparedCandidate>;
  assertPostCommitCurrent?: () => void;
}): Promise<ConfigWriteResult> {
  const {
    io,
    options,
    writeResult,
    baseSnapshot,
    deferRuntimeActivation,
    managedPreparedCandidates,
  } = params;
  let canonicalSourceConfig = params.nextCfg;
  let canonicalRuntimeConfig = params.nextCfg;
  let canonicalPersistedHash = writeResult.persistedHash;
  let envBeforeCanonicalRead = snapshotEnv(io.env);
  let envAfterCanonicalRead: Record<string, string | undefined>;
  let canonicalReadFailure: ConfigRuntimeRefreshError | null = null;
  try {
    let stableEnvGeneration = !deferRuntimeActivation;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const baseline = resolveManagedRuntimeEnvBaseline();
      if (deferRuntimeActivation) {
        replaceEnvSnapshot(
          io.env,
          createConfigRuntimeEnvBase(baseline.sourceConfig, process.env, {
            preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
          }),
        );
        envBeforeCanonicalRead = snapshotEnv(io.env);
      }
      const freshSnapshot = await io.readConfigFileSnapshot();
      if (freshSnapshot.exists && freshSnapshot.valid) {
        canonicalSourceConfig = freshSnapshot.sourceConfig;
        canonicalRuntimeConfig = freshSnapshot.config;
        canonicalPersistedHash = expectDefined(
          freshSnapshot.hash,
          "canonical config snapshot hash",
        );
      } else {
        // An invalid or vanished reread means a concurrent edit beat us to the
        // file; runtime keeps the just-written config, but that divergence must
        // be recorded or the on-disk config silently stops matching runtime.
        const issueSummary = formatConfigIssueSummary(freshSnapshot.issues);
        io.logger.warn(
          `Config (${io.configPath}): canonical reread after write was ${
            freshSnapshot.exists ? "invalid" : "missing"
          }; runtime keeps the written config${issueSummary ? `: ${issueSummary}` : ""}`,
        );
      }
      if (
        !deferRuntimeActivation ||
        resolveManagedRuntimeEnvBaseline().generation === baseline.generation
      ) {
        stableEnvGeneration = true;
        break;
      }
    }
    if (!stableEnvGeneration) {
      canonicalReadFailure = new ConfigRuntimeRefreshError(
        "the active config environment changed during every canonical reread",
      );
    }
  } catch (error) {
    canonicalReadFailure = new ConfigRuntimeRefreshError(
      `canonical reread failed: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    envAfterCanonicalRead = snapshotEnv(io.env);
  }

  const notifyCommittedWrite = () => {
    const currentRuntimeConfig = getRuntimeConfigSnapshot();
    const notificationRuntimeConfig = deferRuntimeActivation
      ? canonicalRuntimeConfig
      : currentRuntimeConfig;
    if (!notificationRuntimeConfig) {
      return;
    }
    const notificationPreparedCandidates = projectRuntimeConfigWritePreparedCandidates(
      managedPreparedCandidates,
      canonicalRuntimeConfig,
      canonicalSourceConfig,
    );
    notifyRuntimeConfigWriteListeners(
      attachRuntimeConfigWriteApplication(
        createRuntimeConfigWriteNotification({
          configPath: io.configPath,
          sourceConfig: canonicalSourceConfig,
          runtimeConfig: notificationRuntimeConfig,
          persistedHash: canonicalPersistedHash,
          afterWrite: options.afterWrite,
          runtimeRefresh: options.runtimeRefresh,
          ...(notificationPreparedCandidates.size > 0
            ? { preparedCandidatesByOwner: notificationPreparedCandidates }
            : {}),
        }),
        getRuntimeConfigWriteApplication(options),
      ),
    );
  };

  try {
    if (canonicalReadFailure) {
      throw canonicalReadFailure;
    }
    options.assertConfigPathForWrite?.();
    await finalizeRuntimeSnapshotWrite({
      assertCurrent: params.assertPostCommitCurrent,
      nextSourceConfig: canonicalSourceConfig,
      refreshOptions: options.runtimeRefresh,
      hadRuntimeSnapshot: params.hadRuntimeSnapshot,
      hadBothSnapshots: params.hadBothSnapshots,
      loadFreshConfig: () => io.loadConfig(),
      notifyCommittedWrite,
      formatRefreshError: (error) => formatErrorMessage(error),
      preflightResult: params.runtimePreflightResult,
      deferRuntimeActivation,
      createRefreshError: (detail, cause) =>
        new ConfigRuntimeRefreshError(`runtime snapshot refresh failed: ${detail}`, { cause }),
    });
  } catch (error) {
    let rollbackStatus: ConfigWriteRollbackStatus = "unknown";
    try {
      const rollback = writeResult[configWritePostCommitRollback];
      const rolledBackConfig = await rollback?.restoreFile(() =>
        params.assertPostCommitCurrent?.(),
      );
      rollbackStatus = rolledBackConfig ? "restored" : "not-restored";
      if (rolledBackConfig) {
        params.assertPostCommitCurrent?.();
        recordUpdateDoctorConfigWrite(
          io.configPath,
          writeResult.persistedHash,
          hashConfigRaw(baseSnapshot.raw),
          writeResult.persistedConfig,
          JSON.stringify(isRecord(baseSnapshot.parsed) ? baseSnapshot.parsed : {}),
        );
        restoreEnvChangesIfUnchanged({
          env: io.env,
          before: envBeforeCanonicalRead,
          after: envAfterCanonicalRead,
        });
        await rollback?.restoreEffects(() => params.assertPostCommitCurrent?.());
      }
    } catch (rollbackError) {
      throw new ConfigWritePostCommitError({
        configPath: io.configPath,
        rollbackStatus,
        cause: new AggregateError(
          [error, rollbackError],
          `${formatErrorMessage(error)} Recovery failed: ${formatErrorMessage(rollbackError)}`,
          { cause: rollbackError },
        ),
      });
    }
    throw new ConfigWritePostCommitError({
      configPath: io.configPath,
      rollbackStatus,
      cause: error,
    });
  }
  return writeResult;
}
