/** Executes Windows Task Scheduler commands with daemon-friendly timeouts. */
import { runCommandWithTimeout } from "../process/exec.js";
import { SCHTASKS_TIMEOUT_MS } from "./schtasks-budget.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 30_000;

/** Runs Windows schtasks with bounded timeouts and normalized process results. */
export async function execSchtasks(
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  assertGatewayServiceUpdateCurrent();
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) {
    return { stdout: "", stderr: "Scheduled Task inspection deadline expired.", code: 124 };
  }
  const cap = timeoutMs === undefined ? undefined : Math.floor(timeoutMs);
  const executionTimeoutMs = Math.min(SCHTASKS_TIMEOUT_MS, cap ?? SCHTASKS_TIMEOUT_MS);
  const noOutputTimeoutMs = Math.min(
    SCHTASKS_NO_OUTPUT_TIMEOUT_MS,
    cap ?? SCHTASKS_NO_OUTPUT_TIMEOUT_MS,
  );
  const result = await runCommandWithTimeout(["schtasks", ...args], {
    baseEnv: resolveServiceManagerEnv(),
    timeoutMs: executionTimeoutMs,
    noOutputTimeoutMs,
  });
  const operation = [args[0], args.find((arg) => /^\/(?:DISABLE|ENABLE)$/i.test(arg))]
    .filter(Boolean)
    .join(" ");
  const timeoutDetail =
    result.termination === "timeout"
      ? `schtasks ${operation} timed out after ${executionTimeoutMs}ms`
      : result.termination === "no-output-timeout"
        ? `schtasks ${operation} produced no output for ${noOutputTimeoutMs}ms`
        : result.termination !== "exit"
          ? `schtasks ${operation} terminated before confirmed completion`
          : "";
  // schtasks can hang without output on some Windows hosts; convert both timeout
  // modes into ordinary process-like failures for service fallback logic.
  return {
    stdout: result.stdout,
    stderr: [timeoutDetail, result.stderr].filter(Boolean).join("\n"),
    code: result.termination === "exit" ? (result.code ?? 1) : result.code || 124,
  };
}
