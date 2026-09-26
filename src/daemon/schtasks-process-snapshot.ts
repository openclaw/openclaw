/** Bounded native Windows process snapshots; callers own interpretation and control. */
import { spawnSync } from "node:child_process";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";

export type WindowsProcessSnapshotEntry = {
  ProcessId?: number;
  CommandLine?: string | null;
};

export function getSnapshotProcessId(entry: WindowsProcessSnapshotEntry): number | null {
  const pid = entry.ProcessId;
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Only fully readable rows can support a negative process-match observation. */
export function isCompleteWindowsProcessSnapshot(
  entries: readonly WindowsProcessSnapshotEntry[],
): boolean {
  // CIM includes the System Idle Process at PID 0, which cannot own this service.
  const candidates = entries.filter((entry) => entry.ProcessId !== 0);
  return (
    candidates.length > 0 &&
    candidates.every(
      (entry) =>
        getSnapshotProcessId(entry) !== null &&
        typeof entry.CommandLine === "string" &&
        entry.CommandLine.trim().length > 0,
    )
  );
}

export function readWindowsProcessSnapshot(
  timeoutMs?: number,
): WindowsProcessSnapshotEntry[] | null {
  if (
    process.platform !== "win32" ||
    (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1))
  ) {
    return null;
  }
  const processTimeoutMs = Math.min(resolveIntegerOption(timeoutMs, 5_000), 5_000);
  const processSnapshot = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "$json = Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        "$bytes = [Text.Encoding]::UTF8.GetBytes($json)",
        // Write pipe bytes directly: OutputEncoding calls SetConsoleOutputCP without a console.
        "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
      ].join("; "),
    ],
    {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: processTimeoutMs,
      windowsHide: true,
    },
  );
  if (processSnapshot.error || processSnapshot.status !== 0) {
    return null;
  }
  let parsedSnapshot: unknown;
  try {
    parsedSnapshot = JSON.parse(processSnapshot.stdout.trim() || "[]");
  } catch {
    return null;
  }
  const entries = (Array.isArray(parsedSnapshot) ? parsedSnapshot : [parsedSnapshot]).filter(
    (entry): entry is WindowsProcessSnapshotEntry => typeof entry === "object" && entry !== null,
  );
  // Healthy CIM includes PowerShell itself; empty output cannot prove target exit.
  return entries.length > 0 ? entries : null;
}
