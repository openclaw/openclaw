import { runCommandWithTimeout } from "../process/exec.js";

const SCHTASKS_TIMEOUT_MS = 15_000;
const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 5_000;

export async function execSchtasks(
  args: string[],
  options: { timeoutMs?: number; noOutputTimeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = options.timeoutMs ?? SCHTASKS_TIMEOUT_MS;
  const noOutputTimeoutMs = options.noOutputTimeoutMs ?? SCHTASKS_NO_OUTPUT_TIMEOUT_MS;
  const result = await runCommandWithTimeout(["schtasks", ...args], {
    timeoutMs,
    noOutputTimeoutMs,
  });
  const timeoutDetail =
    result.termination === "timeout"
      ? `schtasks timed out after ${timeoutMs}ms`
      : result.termination === "no-output-timeout"
        ? `schtasks produced no output for ${noOutputTimeoutMs}ms`
        : "";
  return {
    stdout: result.stdout,
    stderr: result.stderr || timeoutDetail,
    code: typeof result.code === "number" ? result.code : result.killed ? 124 : 1,
  };
}
