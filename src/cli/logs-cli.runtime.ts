import { runCommandWithTimeout } from "../process/exec.js";

export { resolveGatewaySystemdServiceName } from "../daemon/constants.js";
export { readSystemdServiceRuntime } from "../daemon/systemd.js";

const DEFAULT_LOG_SUBPROCESS_TIMEOUT_MS = 10_000;
const STDERR_MAX_BYTES = 64 * 1024;

export async function execFileUtf8Tail(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBytes: number; timeoutMs?: number },
): Promise<{ stdout: string; code: number; truncated: boolean }> {
  try {
    const result = await runCommandWithTimeout([command, ...args], {
      baseEnv: options.env,
      maxOutputBytes: { stdout: options.maxBytes, stderr: STDERR_MAX_BYTES },
      timeoutMs: options.timeoutMs ?? DEFAULT_LOG_SUBPROCESS_TIMEOUT_MS,
    });
    return {
      stdout: result.stdout,
      code: result.code ?? 1,
      truncated: Boolean(result.stdoutTruncatedBytes),
    };
  } catch {
    return {
      stdout: "",
      code: 1,
      truncated: false,
    };
  }
}
