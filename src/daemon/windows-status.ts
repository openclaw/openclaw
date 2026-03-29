import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { resolveGatewayLogPaths } from "./launchd.js";
import { execFileUtf8 } from "./exec-file.js";
import {
  resolveScheduledTaskName,
  resolveStartupEntryPath,
  resolveTaskScriptPath,
} from "./schtasks.js";

export type WindowsWslStatus = {
  wslExeAvailable: boolean;
  defaultDistroName?: string;
  defaultDistroReachable: boolean;
  systemdEnabled?: boolean;
  detail?: string;
  recommendedAction?: string;
};

export type WindowsGatewayStatus = {
  serviceMode: "scheduled-task" | "startup-fallback" | "missing";
  taskName: string;
  taskRegistered: boolean;
  startupEntryInstalled: boolean;
  taskScriptPath: string;
  registrationPath?: string;
  registrationDetail: string;
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
  degradedReason?: string;
  recommendedAction?: string;
  wsl: WindowsWslStatus;
};

type ExecFileUtf8Like = (
  command: string,
  args: string[],
  options?: Omit<ExecFileOptionsWithStringEncoding, "encoding">,
) => Promise<{ stdout: string; stderr: string; code: number }>;

const WSL_PROBE_TIMEOUT_MS = 5_000;

async function pathExists(pathValue: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(pathValue);
    return true;
  } catch {
    return false;
  }
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseDefaultDistroName(output: string): string | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    const defaultMatch = line.match(/^\*\s+(.+?)(?:\s{2,}|\t+)/);
    if (defaultMatch?.[1]) {
      return defaultMatch[1].trim();
    }
  }
  return undefined;
}

function probeTimedOut(result: { stdout: string; stderr: string; code: number }): boolean {
  return /timed out|etimedout/i.test(`${result.stderr}\n${result.stdout}`);
}

async function runWslProbe(
  execFileImpl: ExecFileUtf8Like,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileImpl("wsl.exe", args, {
    windowsHide: true,
    timeout: WSL_PROBE_TIMEOUT_MS,
  }).catch((error: unknown) => ({
    stdout: "",
    stderr: String(error),
    code: 1,
  }));
}

async function readWindowsWslStatus(
  execFileImpl: ExecFileUtf8Like,
): Promise<WindowsWslStatus> {
  const statusProbe = await runWslProbe(execFileImpl, ["--status"]);
  if (probeTimedOut(statusProbe)) {
    return {
      wslExeAvailable: true,
      defaultDistroReachable: false,
      detail: trimOrUndefined(statusProbe.stderr) ?? "wsl.exe did not respond in time.",
      recommendedAction:
        "Open WSL once with `wsl`, finish any first-run distro setup, or run `wsl --shutdown`, then retry.",
    };
  }
  if (statusProbe.code !== 0) {
    return {
      wslExeAvailable: false,
      defaultDistroReachable: false,
      detail: trimOrUndefined(statusProbe.stderr || statusProbe.stdout),
      recommendedAction:
        "Install WSL2 with `wsl --install`, reboot Windows, then rerun the command.",
    };
  }

  const listProbe = await runWslProbe(execFileImpl, ["--list", "--verbose"]);
  const defaultDistroName =
    parseDefaultDistroName(listProbe.stdout) ??
    trimOrUndefined(listProbe.stderr)?.match(/Default Distribution:\s*(.+)$/i)?.[1]?.trim();

  const distroProbe = await runWslProbe(execFileImpl, ["-e", "sh", "-lc", "printf openclaw-wsl-ok"]);
  if (probeTimedOut(distroProbe)) {
    return {
      wslExeAvailable: true,
      defaultDistroName,
      defaultDistroReachable: false,
      detail: trimOrUndefined(distroProbe.stderr) ?? "Default distro probe timed out.",
      recommendedAction:
        "Start the default distro with `wsl`, finish setup, then rerun the command. If WSL is wedged, run `wsl --shutdown` first.",
    };
  }
  if (distroProbe.code !== 0 || !distroProbe.stdout.includes("openclaw-wsl-ok")) {
    return {
      wslExeAvailable: true,
      defaultDistroName,
      defaultDistroReachable: false,
      detail: trimOrUndefined(distroProbe.stderr || distroProbe.stdout),
      recommendedAction:
        "Run `wsl --install -d Ubuntu-24.04` or start your default distro once to finish first-run setup.",
    };
  }

  const systemdProbe = await runWslProbe(execFileImpl, [
    "-e",
    "sh",
    "-lc",
    "if [ -f /etc/wsl.conf ] && grep -Eiq '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true([[:space:]]|$)' /etc/wsl.conf; then printf enabled; else printf disabled; fi",
  ]);
  if (probeTimedOut(systemdProbe)) {
    return {
      wslExeAvailable: true,
      defaultDistroName,
      defaultDistroReachable: true,
      detail: trimOrUndefined(systemdProbe.stderr) ?? "Timed out while checking /etc/wsl.conf for systemd.",
      recommendedAction:
        "If WSL feels stuck, run `wsl --shutdown`, reopen the distro, then rerun `openclaw doctor`.",
    };
  }
  const systemdEnabled = systemdProbe.code === 0 && systemdProbe.stdout.includes("enabled");

  return {
    wslExeAvailable: true,
    defaultDistroName,
    defaultDistroReachable: true,
    systemdEnabled,
    ...(systemdEnabled
      ? {}
      : {
          recommendedAction:
            "Enable systemd in `/etc/wsl.conf`, run `wsl --shutdown` from PowerShell, then reopen your distro.",
        }),
  };
}

export async function collectWindowsGatewayStatus(
  env: NodeJS.ProcessEnv,
  params?: {
    execFileImpl?: ExecFileUtf8Like;
    taskRegistered?: boolean;
    startupEntryInstalled?: boolean;
    runtimeStatus?: string;
    portListening?: boolean;
  },
): Promise<WindowsGatewayStatus> {
  const execFileImpl = params?.execFileImpl ?? execFileUtf8;
  const taskName = resolveScheduledTaskName(env);
  const taskScriptPath = resolveTaskScriptPath(env);
  const startupEntryPath = resolveStartupEntryPath(env);
  const taskRegistered = params?.taskRegistered ?? false;
  const startupEntryInstalled = params?.startupEntryInstalled ?? (await pathExists(startupEntryPath));
  const taskScriptExists = await pathExists(taskScriptPath);
  const logs = resolveGatewayLogPaths(env);
  const wsl = await readWindowsWslStatus(execFileImpl);

  let serviceMode: WindowsGatewayStatus["serviceMode"] = "missing";
  let registrationPath: string | undefined;
  let registrationDetail = "No Windows gateway startup entry is installed.";
  if (taskRegistered) {
    serviceMode = "scheduled-task";
    registrationDetail = `Scheduled Task is registered as ${taskName}.`;
  } else if (startupEntryInstalled) {
    serviceMode = "startup-fallback";
    registrationPath = startupEntryPath;
    registrationDetail = `Startup-folder login item is installed at ${startupEntryPath}.`;
  }

  let degradedReason: string | undefined;
  let recommendedAction: string | undefined;

  if ((taskRegistered || startupEntryInstalled) && !taskScriptExists) {
    degradedReason = "Gateway startup entry points at a missing task script.";
    recommendedAction =
      "Run `openclaw gateway install --force` to recreate the Windows startup script and registration.";
  } else if (
    params?.runtimeStatus === "running" &&
    params.portListening === false
  ) {
    degradedReason = "Gateway service reports running but the configured port is not listening.";
    recommendedAction =
      "Inspect the gateway logs, then run `openclaw gateway restart` or `openclaw doctor`.";
  } else if (serviceMode === "startup-fallback") {
    degradedReason = "Windows is using the Startup-folder fallback instead of a Scheduled Task.";
    recommendedAction =
      "This usually means Scheduled Task creation was denied. Re-run from an elevated PowerShell session if you want stronger supervisor status.";
  }

  return {
    serviceMode,
    taskName,
    taskRegistered,
    startupEntryInstalled,
    taskScriptPath,
    ...(registrationPath ? { registrationPath } : {}),
    registrationDetail,
    logDir: logs.logDir,
    stdoutPath: logs.stdoutPath,
    stderrPath: logs.stderrPath,
    ...(degradedReason ? { degradedReason } : {}),
    ...(recommendedAction ? { recommendedAction } : {}),
    wsl,
  };
}
