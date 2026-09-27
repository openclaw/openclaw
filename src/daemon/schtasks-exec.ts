/** Executes Windows Task Scheduler commands with daemon-friendly timeouts. */
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const SCHTASKS_TIMEOUT_MS = 15_000;
const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 30_000;

/** Runs Windows schtasks with bounded timeouts and normalized process results. */
export async function execSchtasks(
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  assertGatewayServiceUpdateCurrent();
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) {
    throw new Error("Scheduled Task inspection deadline expired.");
  }
  const commandTimeoutMs = Math.min(
    resolveIntegerOption(timeoutMs, SCHTASKS_TIMEOUT_MS),
    SCHTASKS_TIMEOUT_MS,
  );
  const noOutputTimeoutMs =
    timeoutMs === undefined
      ? SCHTASKS_NO_OUTPUT_TIMEOUT_MS
      : Math.min(commandTimeoutMs, SCHTASKS_NO_OUTPUT_TIMEOUT_MS);
  const result = await runCommandWithTimeout(["schtasks", ...args], {
    baseEnv: resolveServiceManagerEnv(),
    timeoutMs: commandTimeoutMs,
    noOutputTimeoutMs,
  });
  const timeoutDetail =
    result.termination === "timeout"
      ? `schtasks timed out after ${commandTimeoutMs}ms`
      : result.termination === "no-output-timeout"
        ? `schtasks produced no output for ${noOutputTimeoutMs}ms`
        : result.termination !== "exit"
          ? "schtasks command terminated before confirmed completion"
          : "";
  // schtasks can hang without output on some Windows hosts; convert both timeout
  // modes into ordinary process-like failures for service fallback logic.
  return {
    stdout: result.stdout,
    stderr: result.stderr || timeoutDetail,
    code: result.termination === "exit" ? (result.code ?? 1) : result.code || 124,
  };
}
