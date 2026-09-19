// Config-write audit/log helper cluster, extracted from io.write.ts so that
// file stays under the line-cap ratchet. Explicit params instead of closures:
// this module has no access to writeConfigFile's local scope.
import type fs from "node:fs";
import { isVerbose } from "../global-state.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import type { ConfigWriteAuditOrigin } from "./io.types.js";
import { resolveConfigStatMetadata } from "./io.write-safety.js";

export function createConfigWriteAuditLog(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  logger: { warn: (message: string) => void };
  skipOutputLogs?: boolean;
  assertConfigPathForWrite?: () => void;
  existsBefore: boolean;
  previousHash: string | null;
  nextHash: string;
  previousBytes: number | null;
  nextBytes: number;
  previousStat: fs.Stats | null;
  changedPathCount: number | null | undefined;
  changedPaths: readonly string[];
  origin?: ConfigWriteAuditOrigin;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspiciousReasons: string[];
}): {
  logConfigOverwrite: () => void;
  logConfigWriteAnomalies: () => void;
  appendWriteAudit: (
    result: ConfigWriteAuditResult,
    error?: unknown,
    nextStat?: fs.Stats | null,
  ) => Promise<void>;
} {
  const readTestLogFlag = (name: string) =>
    isVitestRuntimeEnv(params.env) && params.env[name] === "1";

  const logConfigOverwrite = () => {
    if (
      !params.existsBefore ||
      params.skipOutputLogs ||
      (isVitestRuntimeEnv(params.env) && !readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG"))
    ) {
      return;
    }
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (!isVerbose() && params.env.OPENCLAW_CONFIG_OVERWRITE_LOG !== "1" && !testLog) {
      return;
    }
    params.logger.warn(
      formatConfigOverwriteLogMessage({
        configPath: params.configPath,
        previousHash: params.previousHash,
        nextHash: params.nextHash,
        changedPathCount: params.changedPathCount ?? undefined,
      }),
    );
  };

  const logConfigWriteAnomalies = () => {
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (
      params.suspiciousReasons.length === 0 ||
      params.skipOutputLogs ||
      (isVitestRuntimeEnv(params.env) && !testLog)
    ) {
      return;
    }
    const showMissingMeta =
      isVerbose() || params.env.OPENCLAW_CONFIG_WRITE_ANOMALY_LOG === "1" || testLog;
    const visibleReasons = showMissingMeta
      ? params.suspiciousReasons
      : params.suspiciousReasons.filter((reason) => reason !== "missing-meta-before-write");
    if (visibleReasons.length > 0) {
      params.logger.warn(
        `Config write anomaly: ${params.configPath} (${visibleReasons.join(", ")})`,
      );
    }
  };

  const auditRecordBase = createConfigWriteAuditRecordBase({
    configPath: params.configPath,
    env: params.env,
    existsBefore: params.existsBefore,
    previousHash: params.previousHash,
    nextHash: params.nextHash,
    previousBytes: params.previousBytes,
    nextBytes: params.nextBytes,
    previousMetadata: resolveConfigStatMetadata(params.previousStat),
    changedPathCount: params.changedPathCount,
    changedPaths: params.changedPaths,
    origin: params.origin,
    hasMetaBefore: params.hasMetaBefore,
    hasMetaAfter: params.hasMetaAfter,
    gatewayModeBefore: params.gatewayModeBefore,
    gatewayModeAfter: params.gatewayModeAfter,
    suspicious: params.suspiciousReasons,
  });

  const appendWriteAudit = async (
    result: ConfigWriteAuditResult,
    error?: unknown,
    nextStat?: fs.Stats | null,
  ) => {
    params.assertConfigPathForWrite?.();
    await appendConfigAuditRecord({
      env: params.env,
      homedir: params.homedir,
      record: finalizeConfigWriteAuditRecord({
        base: auditRecordBase,
        result,
        err: error,
        nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
      }),
    });
  };

  return { logConfigOverwrite, logConfigWriteAnomalies, appendWriteAudit };
}
