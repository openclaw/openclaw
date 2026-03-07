import path from "node:path";
import { execFileUtf8 } from "./exec-file.js";

export async function execSchtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileUtf8("schtasks", args, { windowsHide: true });
}

/**
 * Wait until the gateway port is free on Windows.
 * schtasks /End is async; the new process must not start until the port is released.
 */
export async function waitForGatewayPortFreeWindows(port: number): Promise<void> {
  if (!Number.isFinite(port) || port <= 0) return;
  const script = `while (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }`;
  const pwsh =
    process.env.SystemRoot != null
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
  await execFileUtf8(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
  });
}
