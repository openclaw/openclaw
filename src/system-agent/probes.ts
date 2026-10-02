import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { runCommandWithTimeout } from "../process/exec.js";

/**
 * Probes are bounded by output and timeout limits so setup/status commands do
 * not hang or retain unbounded child output.
 */
export type LocalCommandProbe = {
  command: string;
  found: boolean;
  version?: string;
  error?: string;
  /** Missing executables are absence; failed probes must not hide installed backends. */
  failure?: "not-found" | "error";
  timedOut?: boolean;
};

const LOCAL_COMMAND_PROBE_OUTPUT_MAX_CHARS = 16 * 1024;
export async function probeLocalCommand(
  command: string,
  args: string[] = ["--version"],
  opts: { timeoutMs?: number } = {},
): Promise<LocalCommandProbe> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, 1_500);
  try {
    const result = await runCommandWithTimeout([command, ...args], {
      killProcessTree: true,
      maxOutputBytes: LOCAL_COMMAND_PROBE_OUTPUT_MAX_CHARS,
      timeoutMs,
    });
    if (result.termination === "timeout") {
      return {
        command,
        found: true,
        error: `timed out after ${timeoutMs}ms`,
        failure: "error",
        timedOut: true,
      };
    }
    // Version output can arrive on stdout or stderr depending on the CLI.
    const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0]?.trim();
    return {
      command,
      found: result.code === 0 || Boolean(text),
      version: text || undefined,
      error: result.code === 0 ? undefined : `exited ${String(result.code)}`,
      ...(result.code === 0 ? {} : { failure: "error" as const }),
    };
  } catch (error) {
    const spawnError = error as NodeJS.ErrnoException;
    return {
      command,
      found: spawnError.code !== "ENOENT",
      error: spawnError.code === "ENOENT" ? "not found" : spawnError.message,
      failure: spawnError.code === "ENOENT" ? "not-found" : "error",
    };
  }
}

export async function probeGatewayUrl(
  url: string,
): Promise<{ reachable: boolean; url: string; error?: string }> {
  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const healthUrl = new URL("/healthz", httpUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  let response: Response | undefined;
  try {
    response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
    });
    return { reachable: response.ok, url, error: response.ok ? undefined : response.statusText };
  } catch (err) {
    return {
      reachable: false,
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => undefined);
  }
}
