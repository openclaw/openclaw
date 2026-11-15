import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveOpenClawCliInvocation } from "../../../cli-invocation.mjs";
import { resolveStateDir } from "../../config/paths.js";
import {
  normalizeUpdateFailureFacts,
  parseConfigFailureFacts,
} from "../../infra/update-failure-facts.js";
import { redactPublicSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";
import {
  createSanitizedCommandError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { isPlainCommandExitFailure, runExec } from "../../process/exec.js";
import { resolveNodeRunner } from "./shared.js";
import {
  POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
  type PostPluginConfigValidation,
} from "./update-command-post-plugin-validation.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

export async function validatePostPluginConfigInFreshProcess(params: {
  root: string;
  timeoutMs: number;
  entryPath: string;
  nodeRunner?: string;
}): Promise<PostPluginConfigValidation> {
  try {
    const invocation = resolveOpenClawCliInvocation({
      execPath: params.nodeRunner ?? resolveNodeRunner(),
      entryPath: params.entryPath,
      execArgv: [],
      args: ["config", "validate", "--json"],
    });
    await runExec(invocation.command, invocation.args, {
      cwd: params.root,
      timeoutMs: params.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      logOutput: false,
      baseEnv: stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
    });
    return { status: "valid" };
  } catch (error) {
    const result = isRecord(error) ? error : {};
    const cleanupUncertain = result.cleanup === "uncertain" || hasCommandProcessCleanupError(error);
    // The CLI also emits valid:false for runtime exceptions. Only an ordinary
    // completed failure with actual issues establishes invalid authored config.
    const issues =
      !cleanupUncertain &&
      isPlainCommandExitFailure({
        ...result,
        failed: result.failed === true,
        cause: result.cause,
      }) &&
      typeof result.stdout === "string"
        ? parseConfigFailureFacts(result.stdout, process.env)
        : [];
    if (issues.length) {
      return { status: "invalid", failureFacts: issues };
    }
    const summary = [
      createSanitizedCommandError(result).message,
      ...(typeof result.signal === "string" ? [`signal=${result.signal}`] : []),
      ...(cleanupUncertain ? ["cleanup=uncertain"] : []),
    ].join("; ");
    return {
      status: "execution-failed",
      failureFacts: normalizeUpdateFailureFacts([
        {
          check: "config",
          code: POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
          message: summary,
        },
        ...(["stderr", "stdout"] as const).flatMap((stream) => {
          const output = result[stream];
          if (typeof output !== "string" || !output.trim()) {
            return [];
          }
          // Node may print a location or source frame before the actual error.
          // Extract known public causes before single-line fact normalization loses them.
          const diagnostic = redactPublicSupportDiagnosticLine(output, {
            env: process.env,
            stateDir: resolveStateDir(),
          });
          return [
            {
              check: "config",
              code: "command-failed",
              message: `${stream}: ${diagnostic === "[redacted-diagnostic]" ? output : diagnostic}`,
            },
          ];
        }),
      ]),
    };
  }
}
