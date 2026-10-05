import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { formatErrorMessage } from "./errors.js";
import { parseNpmErrorCode } from "./npm-error.js";
import { trimLogTail } from "./restart-sentinel.js";
import { createUpdateErrorFact, createUpdateFailureFact } from "./update-failure-facts.js";
import { createGlobalInstallEnv } from "./update-global.js";
import { createNpmFailureFacts } from "./update-npm-failure.js";
import { createUpdateStepFailureError, isFailedUpdateStep } from "./update-run-step.js";
import { UPDATE_RUN_HEARTBEAT_MS } from "./update-run-timeouts.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateStepInfo,
  UpdateStepProgress,
} from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

export const MAX_LOG_CHARS = 8000;

// A run shares its heartbeat callback across steps; weak keys do not retain completed runs.
const warnedHeartbeats = new WeakSet<() => void>();

function selectCommandFailureMessage(stdout: string, stderr: string): string {
  const lines = stripAnsi(stderr).split(/[\r\n\u2028\u2029]/u);
  if (
    !lines
      .find((line) => line.trim())
      ?.trimStart()
      .startsWith("$ ")
  ) {
    return stderr;
  }
  // Package-manager banners can hide the child Error from the one-line fact formatter.
  return (
    [...lines, ...stripAnsi(stdout).split(/[\r\n\u2028\u2029]/u)].find((line) =>
      /^\s*\w*Error(?: \[[A-Z][A-Z0-9_]*\])?:\s/u.test(line),
    ) ?? stderr
  );
}

export async function reportUpdateStepCompletion(
  progress: UpdateStepProgress | undefined,
  step: Parameters<NonNullable<UpdateStepProgress["onStepComplete"]>>[0],
  commandFailure?: { cause: unknown },
): Promise<void> {
  try {
    await progress?.onStepComplete?.(step);
  } catch (error) {
    if (commandFailure || isFailedUpdateStep(step)) {
      const failure = commandFailure ? commandFailure.cause : createUpdateStepFailureError(step);
      // oxlint-disable-next-line preserve-caught-error -- The reporting error is retained in errors; the command failure remains the cause.
      throw new AggregateError([failure, error], "Update command and completion reporting failed", {
        cause: failure,
      });
    }
    throw error;
  }
}

export async function runStep(opts: RunStepOptions): Promise<UpdateStepResult> {
  const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
  const command = argv.join(" ");
  const stepInfo: UpdateStepInfo = { name, command, index: stepIndex, total: totalSteps };
  await progress?.onStepStart?.(stepInfo);

  const started = Date.now();
  const onHeartbeat = progress?.onHeartbeat;
  const heartbeat = onHeartbeat
    ? setInterval(() => {
        try {
          onHeartbeat();
        } catch (error) {
          if (!warnedHeartbeats.has(onHeartbeat)) {
            warnedHeartbeats.add(onHeartbeat);
            console.warn(
              `[update] Could not refresh the update heartbeat; continuing the command: ${trimLogTail(formatErrorMessage(error), 500)}`,
            );
          }
        }
      }, UPDATE_RUN_HEARTBEAT_MS)
    : undefined;
  heartbeat?.unref();
  let result: Awaited<ReturnType<CommandRunner>>;
  let commandError: { cause: unknown } | undefined;
  let failureFacts: UpdateStepResult["failureFacts"];
  try {
    result = await runCommand(argv, {
      cwd,
      timeoutMs,
      env,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
  } catch (error) {
    commandError = { cause: error };
    const fact = createUpdateErrorFact(name, error, env);
    failureFacts = [fact];
    result = { code: 1, stdout: "", stderr: fact.message ?? "" };
  } finally {
    clearInterval(heartbeat);
  }
  const durationMs = Date.now() - started;
  const stdoutTail = trimLogTail(result.stdout, MAX_LOG_CHARS);
  const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);
  if (
    !failureFacts &&
    result.code !== 0 &&
    [
      "package-install",
      "package-install-prefer-online",
      "package-install-omit-optional",
      "package-pack",
    ].includes(name) &&
    (/(?:^|[\\/])(?:npm|bun)(?:\.cmd|\.exe)?$/iu.test(argv[0] ?? "") ||
      /\bnpm (?:ERR!|error)(?:\s|$)/u.test(`${result.stderr}\n${result.stdout}`))
  ) {
    failureFacts = createNpmFailureFacts(
      result.stdout,
      result.stderr,
      env,
      /(?:^|[\\/])bun(?:\.exe)?$/iu.test(argv[0] ?? "") ? "bun" : "npm",
    );
  }
  failureFacts ??= isFailedUpdateStep({
    exitCode: result.code,
    killed: result.killed,
    outputLimitExceeded: result.outputLimitExceeded,
    termination: result.termination,
  })
    ? [
        createUpdateFailureFact(
          {
            check: name,
            code:
              parseNpmErrorCode(result.stderr) ??
              (result.termination && result.termination !== "exit"
                ? result.termination
                : "command-failed"),
            message: selectCommandFailureMessage(result.stdout, result.stderr),
          },
          env,
        ),
      ]
    : undefined;

  const completion: Omit<UpdateStepResult, "cwd"> = {
    name,
    command,
    durationMs,
    exitCode: result.code,
    stdoutTail,
    stderrTail,
    signal: result.signal,
    killed: result.killed,
    outputLimitExceeded: result.outputLimitExceeded,
    termination: result.termination,
    ...(failureFacts ? { failureFacts } : {}),
  };
  const stepResult: UpdateStepResult = {
    ...completion,
    cwd,
  };
  opts.results?.push(stepResult);
  await reportUpdateStepCompletion(progress, { ...stepInfo, ...completion }, commandError);
  if (commandError) {
    throw commandError.cause;
  }
  return stepResult;
}

export function normalizeFallbackFailureReason(
  stepName: string,
): NonNullable<UpdateRunResult["reason"]> {
  switch (stepName) {
    case "package-install":
    case "package-install-omit-optional":
    case "package-install-prefer-online":
    case "package-stage":
    case "package-verify":
    case "package-swap":
      return "global-install-failed";
    case "openclaw doctor":
      return "doctor-failed";
    case "post-install-verify":
      return "runtime-verification-failed";
    case "post-doctor-ui-build":
      return "ui-build-failed";
    default:
      return "unexpected-error";
  }
}

export async function buildUpdateCommandRunner(
  runCommand?: CommandRunner,
): Promise<{ defaultCommandEnv: NodeJS.ProcessEnv | undefined; runCommand: CommandRunner }> {
  const defaultCommandEnv = await createGlobalInstallEnv();
  return {
    defaultCommandEnv,
    runCommand:
      runCommand ??
      (async (argv, options) =>
        await runCommandWithTimeout(argv, {
          ...options,
          env:
            defaultCommandEnv && options.env
              ? { ...defaultCommandEnv, ...options.env }
              : (defaultCommandEnv ?? options.env),
          // Package-manager trees must not outlive a timed-out updater.
          killProcessTree: true,
        })),
  };
}
