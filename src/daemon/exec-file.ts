/** Native service control/inspection only; payload launchers own their full environment. */
import { extractErrorCode } from "../infra/errors.js";
import {
  CommandProcessCleanupError,
  createSanitizedCommandError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import {
  assertGatewayServiceUpdateCurrent,
  GatewayServiceAuthorityError,
} from "./service-update-authority.js";

export type ExecResult = Pick<SpawnResult, "stdout" | "stderr"> & {
  code: number;
  termination: SpawnResult["termination"] | "error";
  errorCode?: string;
};

/** Runs a child process as UTF-8 and returns exit data instead of throwing on nonzero exit. */
export async function execFileUtf8(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    killSignal?: NodeJS.Signals | number;
    windowsHide?: boolean;
  } = {},
): Promise<ExecResult> {
  const scoped = assertGatewayServiceUpdateCurrent();
  try {
    const { stdout, stderr, code, termination, signal, cleanup } = await runCommandWithTimeout(
      [command, ...args],
      {
        baseEnv: resolveServiceManagerEnv(options.env),
        // sudo -u can inherit an operator directory the service account cannot enter.
        cwd: options.cwd ?? (process.platform === "win32" ? undefined : "/"),
        killSignal: options.killSignal,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: options.timeout,
      },
    );
    // Mutation scopes cannot compensate while an earlier writer may still run.
    // Unscoped status probes retain their ordinary timeout diagnostics.
    if (scoped && cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    assertGatewayServiceUpdateCurrent();
    const diagnostic =
      termination === "exit"
        ? ""
        : createSanitizedCommandError({
            timedOut: termination === "timeout" || termination === "no-output-timeout",
            isTerminated: true,
            signal,
          }).message;
    // A child can exit zero while handling termination; daemon actions must still fail.
    return {
      stdout,
      stderr: [stderr, diagnostic].filter(Boolean).join("\n"),
      code: termination === "exit" ? (code ?? 1) : code || 1,
      termination,
    };
  } catch (error) {
    if (error instanceof GatewayServiceAuthorityError || hasCommandProcessCleanupError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = extractErrorCode(error);
    // Launch diagnostics omit argv; preserve errno separately so daemon owners
    // never have to recover execution failures from sanitized prose.
    return { stdout: "", stderr: message, code: 1, termination: "error", errorCode };
  }
}
