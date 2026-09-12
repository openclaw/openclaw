import { runCommandWithTimeout } from "../process/exec.js";
import { formatErrorMessage } from "./errors.js";
import { trimLogTail } from "./restart-sentinel.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";
import { createGlobalInstallEnv } from "./update-global.js";
import { UPDATE_RUN_HEARTBEAT_MS } from "./update-run-timeouts.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateStepInfo,
  UpdateStepResult,
} from "./update-runner-types.js";

export const UPDATE_RUNNER_TIMEOUT_MS = 20 * 60_000;
export const MAX_LOG_CHARS = 8000;

// A run shares its heartbeat callback across steps; weak keys do not retain completed runs.
const warnedHeartbeats = new WeakSet<() => void>();

function mergeCommandEnvironments(
  baseEnv: NodeJS.ProcessEnv | undefined,
  overrideEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!baseEnv) {
    return overrideEnv;
  }
  if (!overrideEnv) {
    return baseEnv;
  }
  return { ...baseEnv, ...overrideEnv };
}

export async function runStep(opts: RunStepOptions): Promise<UpdateStepResult> {
  const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
  const command = argv.join(" ");
  const stepInfo: UpdateStepInfo = { name, command, index: stepIndex, total: totalSteps };
  progress?.onStepStart?.(stepInfo);

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
  try {
    result = await runCommand(argv, {
      cwd,
      timeoutMs,
      env,
    });
  } finally {
    clearInterval(heartbeat);
  }
  const durationMs = Date.now() - started;
  const stdoutTail = trimLogTail(result.stdout, MAX_LOG_CHARS);
  const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);
  const failureFacts =
    result.code !== 0 || result.killed || result.termination === "timeout"
      ? [
          createUpdateFailureFact(
            {
              check: name.startsWith("global ") ? "package-install" : name,
              code:
                result.stderr.match(/\bnpm (?:ERR!|error) code ([A-Z][A-Z0-9_]+)/u)?.[1] ??
                (result.termination && result.termination !== "exit"
                  ? result.termination
                  : "command-failed"),
              message: result.stderr,
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
    termination: result.termination,
    ...(failureFacts ? { failureFacts } : {}),
  };
  progress?.onStepComplete?.({ ...stepInfo, ...completion });

  const stepResult: UpdateStepResult = {
    ...completion,
    cwd,
  };
  opts.results?.push(stepResult);
  return stepResult;
}

export function normalizeFallbackFailureReason(
  stepName: string,
): NonNullable<UpdateRunResult["reason"]> {
  switch (stepName) {
    case "global update":
    case "global update (omit optional)":
    case "global install stage":
    case "global install verify":
    case "global install swap":
      return "global-install-failed";
    case "openclaw doctor":
      return "doctor-failed";
    case "post-install verification":
      return "runtime-verification-failed";
    case "ui:build (post-doctor repair)":
      return "ui-build-failed";
    default:
      return "unexpected-error";
  }
}

export async function buildUpdateCommandRunner(
  runCommand?: CommandRunner,
): Promise<{ defaultCommandEnv: NodeJS.ProcessEnv | undefined; runCommand: CommandRunner }> {
  const defaultCommandEnv = await createGlobalInstallEnv();
  if (runCommand) {
    return { defaultCommandEnv, runCommand };
  }
  return {
    defaultCommandEnv,
    runCommand: async (argv, options) =>
      await runCommandWithTimeout(argv, {
        ...options,
        env: mergeCommandEnvironments(defaultCommandEnv, options.env),
        // Package-manager trees must not outlive a timed-out updater.
        killProcessTree: true,
      }),
  };
}
