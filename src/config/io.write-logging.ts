import { isVerbose } from "../global-state.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { formatConfigOverwriteLogMessage } from "./io.audit.js";

export function createConfigWriteLoggers(params: {
  changedPathCount: number;
  configPath: string;
  env: NodeJS.ProcessEnv;
  existsBefore: boolean;
  logger: Pick<typeof console, "warn">;
  nextHash: string;
  previousHash: string | null;
  skipOutputLogs?: boolean;
  suspiciousReasons: readonly string[];
}): { logConfigOverwrite: () => void; logConfigWriteAnomalies: () => void } {
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
        changedPathCount: params.changedPathCount,
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
  return { logConfigOverwrite, logConfigWriteAnomalies };
}
