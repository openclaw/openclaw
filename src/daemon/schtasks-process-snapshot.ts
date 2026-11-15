/** Bounded native Windows process snapshots; callers own interpretation and control. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import { readWindowsTaskSupervisorRestartExitCode } from "./windows-task-supervisor-contract.js";

export type WindowsProcessSnapshotEntry = {
  ProcessId?: number;
  CommandLine?: string | null;
  Name?: string | null;
};

export function getSnapshotProcessId(entry: WindowsProcessSnapshotEntry): number | null {
  const pid = entry.ProcessId;
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function isNodeHostArgv(programArguments: string[]): boolean {
  const normalized = normalizeProgramArguments(programArguments);
  return normalized.some((arg, index) => arg === "node" && normalized[index + 1] === "run");
}

function normalizeProgramArguments(programArguments: string[]): string[] {
  return programArguments.map((arg) => normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/")));
}

export function matchesInstalledProgramArguments(
  actualArguments: string[],
  installedArguments: string[],
): boolean {
  const actual = normalizeProgramArguments(actualArguments);
  const installed = normalizeProgramArguments(installedArguments);
  return (
    actual.length === installed.length && actual.every((arg, index) => arg === installed[index])
  );
}

export function findInstalledProcessPid(
  entries: WindowsProcessSnapshotEntry[],
  port: number,
  installedArguments: string[],
  matchesProcess: (argv: string[]) => boolean,
  comparableArguments: (argv: string[]) => string[] = (argv) => argv,
): number | null {
  for (const entry of entries) {
    const commandLine = normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "");
    if (!commandLine) {
      continue;
    }
    const argv = parseWindowsNativeCommandLine(entry.CommandLine ?? "");
    if (
      !argv ||
      !matchesProcess(argv) ||
      parseTcpPortFromArgs(argv) !== port ||
      !matchesInstalledProgramArguments(comparableArguments(argv), installedArguments)
    ) {
      continue;
    }
    const pid = getSnapshotProcessId(entry);
    if (pid) {
      return pid;
    }
  }
  return null;
}

export function matchesInstalledGatewayChildArguments(
  actualArguments: string[],
  installedArguments: string[],
): boolean {
  return (
    readWindowsTaskSupervisorRestartExitCode(actualArguments) !== undefined &&
    matchesInstalledProgramArguments(actualArguments.slice(0, -1), installedArguments)
  );
}

/** Finds the current supervised child or a legacy directly launched Gateway. */
export function findInstalledGatewayChildPid(
  entries: WindowsProcessSnapshotEntry[],
  port: number,
  installedArguments: string[],
): number | null {
  const supervisedPid = findInstalledProcessPid(
    entries,
    port,
    installedArguments,
    (argv) => readWindowsTaskSupervisorRestartExitCode(argv) !== undefined,
    (argv) => argv.slice(0, -1),
  );
  return supervisedPid ?? findInstalledProcessPid(entries, port, installedArguments, () => true);
}

function nativeImageBasename(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[<>:"/\\|?*]/u.test(value) &&
    Array.from(value).every((character) => character.charCodeAt(0) >= 32)
    ? value.toLowerCase()
    : undefined;
}

/** Native image names can exclude unrelated protected processes, never prove a matching command. */
export function isCompleteWindowsProcessSnapshot(
  entries: readonly WindowsProcessSnapshotEntry[],
  executable?: string,
): boolean {
  const basename =
    executable &&
    path.win32.isAbsolute(executable) &&
    path.win32.parse(executable).root.length > 1 &&
    !/[%!\r\n\0]/u.test(executable)
      ? nativeImageBasename(path.win32.basename(executable))
      : undefined;
  const expectedImage = basename?.endsWith(".exe") ? basename : undefined;
  // CIM includes the System Idle Process at PID 0, which cannot own this service.
  const candidates = entries.filter((entry) => entry.ProcessId !== 0);
  return (
    candidates.length > 0 &&
    candidates.every((entry) => {
      if (getSnapshotProcessId(entry) === null) {
        return false;
      }
      if (
        typeof entry.CommandLine === "string" &&
        (parseWindowsNativeCommandLine(entry.CommandLine)?.length ?? 0) > 0
      ) {
        return true;
      }
      const image = nativeImageBasename(entry.Name);
      return expectedImage !== undefined && image !== undefined && image !== expectedImage;
    })
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
        "$json = Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,CommandLine,Name | ConvertTo-Json -Compress",
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
  const parsedSnapshot = safeParseJson(processSnapshot.stdout.trim() || "[]");
  const entries = (Array.isArray(parsedSnapshot) ? parsedSnapshot : [parsedSnapshot]).filter(
    (entry): entry is WindowsProcessSnapshotEntry => typeof entry === "object" && entry !== null,
  );
  // Healthy CIM includes PowerShell itself; empty output cannot prove target exit.
  return entries.length > 0 ? entries : null;
}
