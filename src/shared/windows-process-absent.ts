// Windows-only absence oracle for lock-owner recovery. GetProcessById throws
// ArgumentException exactly when the kernel has no such PID; protected or
// otherwise unreadable processes still resolve, so a positive "absent" never
// depends on locale-specific error text.
import childProcess from "node:child_process";
import path from "node:path";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.ts";

const ABSENCE_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = resolveDiagnosticProcessEnv(env, "win32").SystemRoot ?? env.SystemRoot;
  const root =
    systemRoot && /^[A-Za-z]:\\/.test(path.win32.normalize(systemRoot))
      ? systemRoot
      : DEFAULT_WINDOWS_SYSTEM_ROOT;
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Returns true only when Windows itself reports that no process with this PID
 * exists. Any probe failure (timeout, missing shell, unexpected exception)
 * returns false so lock recovery stays conservative for live-but-protected
 * owners.
 */
export function isWindowsProcessDefinitelyAbsent(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    const verdict = childProcess
      .execFileSync(
        windowsPowerShellPath(env),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `try { $null = [System.Diagnostics.Process]::GetProcessById(${pid}); 'present' } ` +
            `catch [System.ArgumentException] { 'absent' } catch { 'unknown' }`,
        ],
        {
          encoding: "utf8",
          env: resolveDiagnosticProcessEnv(env, "win32"),
          timeout: ABSENCE_PROBE_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      )
      .toString()
      .trim();
    return verdict === "absent";
  } catch {
    // Probe could not run or did not answer in budget: never claim absence.
    return false;
  }
}
