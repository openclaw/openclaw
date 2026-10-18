import type fs from "node:fs";
import { isVerbose } from "../global-state.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { restoreConfigSnapshotAuditRecordAsync } from "./config-journal-snapshot.js";
import {
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import { withConfigWriteState } from "./io.meta.js";
import { loggedConfigWarningFingerprints, setBoundedConfigIoWarningEntry } from "./io.state.js";
import { resolveConfigStatMetadata } from "./io.write-safety.js";

export function createConfigWriteAuditLog(
  params: Parameters<typeof createConfigWriteAuditRecordBase>[0] & {
    changedPathCount?: number;
    logger: Pick<typeof console, "warn">;
    skipOutputLogs?: boolean;
    appendRecord: (record: ReturnType<typeof finalizeConfigWriteAuditRecord>) => Promise<void>;
  },
) {
  const { env, configPath, suspicious: suspiciousReasons } = params;
  const readTestLogFlag = (name: string) => isVitestRuntimeEnv(env) && env[name] === "1";
  const logConfigOverwrite = () => {
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (!params.existsBefore || params.skipOutputLogs || (isVitestRuntimeEnv(env) && !testLog)) {
      return;
    }
    if (!isVerbose() && env.OPENCLAW_CONFIG_OVERWRITE_LOG !== "1" && !testLog) {
      return;
    }
    params.logger.warn(
      formatConfigOverwriteLogMessage({
        configPath,
        previousHash: params.previousHash,
        nextHash: params.nextHash,
        changedPathCount: params.changedPathCount,
      }),
    );
  };
  const logConfigWriteAnomalies = () => {
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (
      suspiciousReasons.length === 0 ||
      params.skipOutputLogs ||
      (isVitestRuntimeEnv(env) && !testLog)
    ) {
      return;
    }
    const showMissingMeta = isVerbose() || env.OPENCLAW_CONFIG_WRITE_ANOMALY_LOG === "1" || testLog;
    const visibleReasons = showMissingMeta
      ? suspiciousReasons
      : suspiciousReasons.filter((reason) => reason !== "missing-meta-before-write");
    if (visibleReasons.length > 0) {
      params.logger.warn(`Config write anomaly: ${configPath} (${visibleReasons.join(", ")})`);
    }
  };
  const base = createConfigWriteAuditRecordBase(params);
  const appendWriteAudit = async (
    result: ConfigWriteAuditResult,
    error?: unknown,
    nextStat?: fs.Stats | null,
  ) => {
    await params.appendRecord(
      finalizeConfigWriteAuditRecord({
        base,
        result,
        err: error,
        nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
      }),
    );
  };
  return { logConfigOverwrite, logConfigWriteAnomalies, appendWriteAudit };
}

export function createConfigWriteEffectRestorer(
  params: Parameters<typeof restoreConfigSnapshotAuditRecordAsync>[0] & {
    configPath: string;
    stateSelection: Parameters<typeof withConfigWriteState>[0];
    previousWarningFingerprint: string | undefined;
  },
) {
  return async (assertCurrent: () => void) => {
    assertCurrent();
    await withConfigWriteState(params.stateSelection, () =>
      restoreConfigSnapshotAuditRecordAsync(params, assertCurrent),
    );
    assertCurrent();
    if (params.previousWarningFingerprint === undefined) {
      loggedConfigWarningFingerprints.delete(params.configPath);
    } else {
      setBoundedConfigIoWarningEntry(
        loggedConfigWarningFingerprints,
        params.configPath,
        params.previousWarningFingerprint,
      );
    }
  };
}
