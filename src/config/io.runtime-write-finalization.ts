import fs from "node:fs";
import { isMainThread } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { loadDotEnv, loadDotEnvAsync } from "../infra/dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { recordUpdateDoctorConfigWrite } from "../infra/update-doctor-result.js";
import { createConfigRuntimeEnvBase, prepareConfigRuntimeEnvLoad } from "./config-env-vars.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import { createConfigIO } from "./io.factory.js";
import {
  hashConfigRaw,
  replaceEnvSnapshot,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
import { resolveManagedRuntimeEnvBaseline } from "./io.runtime-env.js";
import type {
  ConfigIoFactoryOptions,
  ConfigWriteOptions,
  ConfigWriteResult,
  ReadConfigFileSnapshotForWriteResult,
} from "./io.types.js";
import { ConfigRuntimeRefreshError, configWritePostCommitRollback } from "./io.types.js";
import { ConfigWritePostCommitError, type ConfigWriteRollbackStatus } from "./io.write-errors.js";
import { assertBaseSnapshotStillCurrent } from "./io.write-safety.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import {
  finalizeRuntimeSnapshotWrite,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import { publishRuntimeConfigWrite } from "./runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export async function finalizeCommittedConfigWrite(params: {
  io: ReturnType<typeof createConfigIO>;
  ioOptions: ConfigIoFactoryOptions;
  options: ConfigWriteOptions;
  nextCfg: OpenClawConfig;
  writeResult: Awaited<ReturnType<ReturnType<typeof createConfigIO>["writeConfigFile"]>>;
  baseSnapshot: ConfigFileSnapshot;
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
  let canonicalRead: ReadConfigFileSnapshotForWriteResult | undefined;
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
      canonicalRead = await io.readConfigFileSnapshotForWrite();
      const freshSnapshot = canonicalRead.snapshot;
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
    publishRuntimeConfigWrite({
      configPath: io.configPath,
      snapshot: expectDefined(canonicalRead, "canonical config reread").snapshot,
      sourceConfig: canonicalSourceConfig,
      runtimeConfig: canonicalRuntimeConfig,
      persistedHash: canonicalPersistedHash,
      deferRuntimeActivation,
      preparedCandidates: managedPreparedCandidates,
      writeOptions: options,
    });
  };

  try {
    if (canonicalReadFailure) {
      throw canonicalReadFailure;
    }
    options.assertConfigPathForWrite?.();
    await finalizeRuntimeSnapshotWrite({
      assertCurrent: () => {
        params.assertPostCommitCurrent?.();
        const read = expectDefined(canonicalRead, "canonical config reread");
        read.writeOptions.assertConfigPathForWrite?.();
        assertBaseSnapshotStillCurrent(read.snapshot, io.configPath, fs, {
          hashes: read.writeOptions.includeFileHashesForWrite ?? {},
          targets: read.writeOptions.includeFileTargetsForWrite ?? {},
        });
      },
      nextSourceConfig: canonicalSourceConfig,
      refreshOptions: options.runtimeRefresh,
      hadBothSnapshots: params.hadBothSnapshots,
      freshConfig: async (assertCurrent) => {
        assertCurrent();
        const stage = prepareConfigRuntimeEnvLoad({
          previousConfig: resolveManagedRuntimeEnvBaseline().sourceConfig,
          env: io.env,
          preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
        });
        const stagedIo = createConfigIO({
          ...params.ioOptions,
          configPath: io.configPath,
          env: stage.env,
        });
        try {
          if (isMainThread) {
            await loadDotEnvAsync({ env: stage.env, quiet: true });
          } else {
            loadDotEnv({ env: stage.env, quiet: true });
          }
        } finally {
          stage.captureDotEnvBaseline();
          assertCurrent();
          // Ambient dotenv survives later config failure; config vars remain staged.
          stage.prepareFailure().publish().commit();
        }
        const config = await stagedIo.loadConfigAsync({ assertCurrent });
        assertCurrent();
        return { config, runtimeEnv: stage.prepare(config) };
      },
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
        rollback?.restoreEffects(() => params.assertPostCommitCurrent?.());
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
