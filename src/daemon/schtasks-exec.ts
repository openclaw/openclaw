/** Executes Windows Task Scheduler commands with daemon-friendly timeouts. */
import { runCommandWithTimeout } from "../process/exec.js";
import { SCHTASKS_TIMEOUT_MS } from "./schtasks-budget.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 30_000;

/** Runs Windows schtasks with bounded timeouts and normalized process results. */
export async function execSchtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  assertGatewayServiceUpdateCurrent();
  const result = await runCommandWithTimeout(["schtasks", ...args], {
    baseEnv: resolveServiceManagerEnv(),
    timeoutMs: SCHTASKS_TIMEOUT_MS,
    noOutputTimeoutMs: SCHTASKS_NO_OUTPUT_TIMEOUT_MS,
  });
  const operation = [args[0], args.find((arg) => /^\/(?:DISABLE|ENABLE)$/i.test(arg))]
    .filter(Boolean)
    .join(" ");
  const timeoutDetail =
    result.termination === "timeout"
      ? `schtasks ${operation} timed out after ${SCHTASKS_TIMEOUT_MS}ms`
      : result.termination === "no-output-timeout"
        ? `schtasks ${operation} produced no output for ${SCHTASKS_NO_OUTPUT_TIMEOUT_MS}ms`
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
