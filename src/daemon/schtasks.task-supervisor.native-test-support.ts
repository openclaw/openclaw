import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { readWindowsProcessSnapshot, terminateGatewayProcessTree } from "./schtasks-process.js";
import { launchFallbackTaskScript, resolveFallbackRuntime } from "./schtasks-runtime.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";
import {
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX,
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN,
} from "./windows-task-supervisor-contract.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;

type WindowsProcessDiagnostic = {
  CommandLine?: string | null;
  ParentProcessId?: number;
  ProcessId?: number;
};

export type GatewayTaskSupervisorProbe = {
  childPidPath: string;
  failedAttemptPidPath: string;
  failedSupervisorPidPath: string;
  probePath: string;
  supervisorPidPath: string;
};

type GatewayTaskSupervisorProcesses = { childPid: number; supervisorPid: number };
type ExactProbeRun = { pid: number; ppid: number };
type HostedLifecycleEvent = {
  phase: string;
  code?: number;
  outcome?: string;
  reason?: string;
  roots?: number;
  active?: number;
  queued?: number;
};

async function sleep(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, WAIT_INTERVAL_MS);
  });
}

async function waitForRecordedPid(pidPath: string, label: string): Promise<number> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(pidPath, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 1) {
      return pid;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for Scheduled Task ${label} process id`);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for Scheduled Task process ${pid} to exit`);
}

export function stopGatewayTaskWithPowerShell(taskName: string): void {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "Stop-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction Stop",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Stop-ScheduledTask failed for ${taskName}: ${result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`}`,
    );
  }
}

export function createGatewayTaskSupervisorProbe(rootDir: string): GatewayTaskSupervisorProbe {
  return {
    childPidPath: path.join(rootDir, "child-pid.txt"),
    failedAttemptPidPath: path.join(rootDir, "failed-attempt-pid.txt"),
    failedSupervisorPidPath: path.join(rootDir, "failed-supervisor-pid.txt"),
    probePath: path.join(rootDir, "probe.mts"),
    supervisorPidPath: path.join(rootDir, "supervisor-pid.txt"),
  };
}

export async function writeGatewayTaskSupervisorProbe(params: {
  activePidPath: string;
  eventsPath: string;
  probe: GatewayTaskSupervisorProbe;
}): Promise<void> {
  const taskSupervisorModuleUrl = new URL("../cli/gateway-cli/task-supervisor.ts", import.meta.url)
    .href;
  const hostedProbeModuleUrl = new URL(
    "./schtasks.hosted-stop.native-test-support.ts",
    import.meta.url,
  ).href;
  await fs.writeFile(
    params.probe.probePath,
    [
      'import fs from "node:fs";',
      // Bound Scheduler's inherited logon environment before importing product
      // owners. Actions service tokens must not reach the supervisor or Gateway.
      "const allowedEnv = new Set([",
      '  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP",',
      '  "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",',
      '  "OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH",',
      '  "OPENCLAW_GATEWAY_PORT", "OPENCLAW_SERVICE_KIND", "OPENCLAW_SERVICE_MARKER",',
      '  "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER",',
      '  "TSX_TSCONFIG_PATH",',
      "]);",
      "for (const key of Object.keys(process.env)) if (!allowedEnv.has(key.toUpperCase())) delete process.env[key];",
      "const eventsPath = process.argv[5];",
      "const activePidPath = process.argv[6];",
      "const childPidPath = process.argv[7];",
      "const supervisorPidPath = process.argv[8];",
      "const failedAttemptPidPath = process.argv[9];",
      "const failedSupervisorPidPath = process.argv[10];",
      "const appendEvent = (phase, details = {}) => fs.appendFileSync(phase === 'started' || phase === 'listening' ? eventsPath : eventsPath + '.hosted-stop', `${JSON.stringify({ phase, pid: process.pid, ppid: process.ppid, ...details })}\\n`);",
      "process.once('exit', (code) => appendEvent('process-exit', { code }));",
      "appendEvent('bounded-environment', { keys: Object.keys(process.env).map((key) => key.toUpperCase()).sort() });",
      "if (process.argv.includes('--task-supervisor')) {",
      "  fs.writeFileSync(supervisorPidPath, String(process.pid));",
      `  const { runWindowsGatewayTaskSupervisor } = await import(${JSON.stringify(taskSupervisorModuleUrl)});`,
      "  await runWindowsGatewayTaskSupervisor();",
      "  appendEvent('supervisor-joined', { code: process.exitCode ?? 0 });",
      "} else if (!fs.existsSync(failedAttemptPidPath)) {",
      // Preserve this run's supervisor before a recovery launch overwrites its live PID file.
      "  fs.copyFileSync(supervisorPidPath, failedSupervisorPidPath);",
      "  fs.writeFileSync(failedAttemptPidPath, String(process.pid));",
      "  process.exit(23);",
      "} else {",
      'const portIndex = process.argv.indexOf("--port");',
      "const port = Number.parseInt(process.argv[portIndex + 1] ?? '', 10);",
      "if (!Number.isInteger(port) || port < 1) throw new Error('Missing gateway --port');",
      'appendEvent("started");',
      `const { runHostedStopNativeProbe } = await import(${JSON.stringify(hostedProbeModuleUrl)});`,
      "await runHostedStopNativeProbe({ port, activePidPath, childPidPath, appendEvent });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

export function buildGatewayTaskSupervisorProgramArguments(params: {
  activePidPath: string;
  eventsPath: string;
  gatewayPort: number;
  probe: GatewayTaskSupervisorProbe;
}): string[] {
  // The task runs from a temporary workspace, not the checkout that owns tsx.
  const tsxImportUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return [
    process.execPath,
    "--import",
    tsxImportUrl,
    params.probe.probePath,
    "gateway",
    "--port",
    String(params.gatewayPort),
    params.eventsPath,
    params.activePidPath,
    params.probe.childPidPath,
    params.probe.supervisorPidPath,
    params.probe.failedAttemptPidPath,
    params.probe.failedSupervisorPidPath,
  ];
}

export async function waitForGatewayTaskSupervisorProcesses(params: {
  probe: GatewayTaskSupervisorProbe;
  failedAttempt?: boolean;
}): Promise<{ childPid: number; supervisorPid: number }> {
  const childPidPath = params.failedAttempt
    ? params.probe.failedAttemptPidPath
    : params.probe.childPidPath;
  const supervisorPidPath = params.failedAttempt
    ? params.probe.failedSupervisorPidPath
    : params.probe.supervisorPidPath;
  const [childPid, supervisorPid] = await Promise.all([
    waitForRecordedPid(childPidPath, "child"),
    waitForRecordedPid(supervisorPidPath, "supervisor"),
  ]);
  return { childPid, supervisorPid };
}

export function expectGatewayTaskSupervisorProcessAlive(pid: number, probePath: string): void {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`Scheduled Task probe ${pid} did not remain alive`);
  }
  const processEntry = readWindowsProcessSnapshot()?.find((entry) => entry.ProcessId === pid);
  const commandLine = (processEntry?.CommandLine ?? "").replaceAll("/", "\\").toLowerCase();
  expect(commandLine).toContain("--task-supervisor");
  expect(commandLine).toContain(probePath.replaceAll("/", "\\").toLowerCase());
}

export async function waitForGatewayTaskSupervisorExit(pids: {
  childPid: number;
  supervisorPid: number;
}): Promise<void> {
  await Promise.all([waitForProcessExit(pids.childPid), waitForProcessExit(pids.supervisorPid)]);
}

export function expectPlannedGatewayRestartEvents(events: HostedLifecycleEvent[]): void {
  expect(events.find((event) => event.phase === "boot-completion")).toMatchObject({
    outcome: "planned_restart",
  });
  const restartExitCode = events.find((event) => event.phase === "gateway-exit")?.code;
  expect(restartExitCode).toBeGreaterThanOrEqual(WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN);
  expect(restartExitCode).toBeLessThanOrEqual(WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX);
  expect(events.find((event) => event.phase === "process-exit")?.code).toBe(restartExitCode);
}

export function expectCleanHostedGatewayStopEvents(events: HostedLifecycleEvent[]): void {
  const phases = events.map((event) => event.phase);
  expect(phases).not.toContain("request-failed");
  expect(phases.filter((phase) => phase === "caller-live").length).toBeGreaterThan(1);
  expect(phases.filter((phase) => phase !== "caller-live")).toEqual([
    "bounded-environment",
    "operation-settled",
    "response-finished",
    "close",
    "descendant-exit",
    "boot-completion",
    "gateway-exit",
    "process-exit",
  ]);
  expect(events.find((event) => event.phase === "close")).toMatchObject({
    roots: 0,
    active: 0,
    queued: 0,
  });
  expect(events.find((event) => event.phase === "boot-completion")).toMatchObject({
    outcome: "clean_stop",
    reason: "gateway.stop",
  });
  for (const phase of ["descendant-exit", "gateway-exit", "process-exit"]) {
    expect(events.find((event) => event.phase === phase)?.code).toBe(0);
  }
}

export async function proveHostedGatewayRestart(params: {
  canBindLoopbackPort: (port: number) => Promise<boolean>;
  eventsPath: string;
  expectedRunCount: number;
  gatewayPort: number;
  previousGatewayPid: number;
  previousProcesses: GatewayTaskSupervisorProcesses;
  probe: GatewayTaskSupervisorProbe;
  waitForExactProbeRun: (eventsPath: string, count: number) => Promise<ExactProbeRun>;
}): Promise<{
  gatewayPid: number;
  portRecovered: boolean;
  processes: GatewayTaskSupervisorProcesses;
  response: unknown;
}> {
  const response = await fetch(`http://127.0.0.1:${params.gatewayPort}/approved-restart`, {
    method: "POST",
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
  });
  expect(response.status).toBe(200);
  const scheduled = await response.json();
  expect(scheduled).toEqual({ outcome: "scheduled", nativeCompleted: false });
  await Promise.all([
    waitForProcessExit(params.previousGatewayPid),
    waitForProcessExit(params.previousProcesses.childPid),
  ]);
  const run = await params.waitForExactProbeRun(params.eventsPath, params.expectedRunCount);
  const processes = await waitForGatewayTaskSupervisorProcesses({ probe: params.probe });
  expect(run.pid).not.toBe(params.previousGatewayPid);
  expect(processes.childPid).not.toBe(params.previousProcesses.childPid);
  expect(processes.supervisorPid).toBe(params.previousProcesses.supervisorPid);
  expect(isProcessAlive(run.pid)).toBe(true);
  expect(isProcessAlive(processes.childPid)).toBe(true);
  expectGatewayTaskSupervisorProcessAlive(processes.supervisorPid, params.probe.probePath);
  const portRecovered = !(await params.canBindLoopbackPort(params.gatewayPort));
  expect(portRecovered).toBe(true);
  return { gatewayPid: run.pid, portRecovered, processes, response: scheduled };
}

export async function proveStartupFallbackGatewayControl(params: {
  activePidPath: string;
  clearActivePid: (activePidPath: string, pid: number) => Promise<void>;
  command: GatewayServiceCommandConfig;
  env: GatewayServiceEnv;
  eventsPath: string;
  expectedRunCount: number;
  gatewayPort: number;
  probe: GatewayTaskSupervisorProbe;
  waitForExactProbeRun: (eventsPath: string, count: number) => Promise<ExactProbeRun>;
  waitForLoopbackPortRelease: (port: number) => Promise<void>;
}): Promise<{
  childPid: number;
  gatewayPid: number;
  matchedGatewayPid: number | undefined;
  stopped: true;
  supervisorPid: number;
}> {
  await Promise.all([
    fs.rm(params.activePidPath, { force: true }),
    fs.rm(params.probe.childPidPath, { force: true }),
    fs.rm(params.probe.supervisorPidPath, { force: true }),
  ]);
  await launchFallbackTaskScript(params.env, params.command);
  const run = await params.waitForExactProbeRun(params.eventsPath, params.expectedRunCount);
  const processes = await waitForGatewayTaskSupervisorProcesses({ probe: params.probe });
  expect(isProcessAlive(run.pid)).toBe(true);
  expect(isProcessAlive(processes.childPid)).toBe(true);
  expectGatewayTaskSupervisorProcessAlive(processes.supervisorPid, params.probe.probePath);
  const runtime = await resolveFallbackRuntime(params.env, params.command, "control");
  expect(runtime).toMatchObject({ status: "running", pid: run.pid });
  await terminateGatewayProcessTree(run.pid, 300);
  await Promise.all([waitForProcessExit(run.pid), waitForGatewayTaskSupervisorExit(processes)]);
  await params.clearActivePid(params.activePidPath, run.pid);
  await params.waitForLoopbackPortRelease(params.gatewayPort);
  return {
    gatewayPid: run.pid,
    ...processes,
    matchedGatewayPid: runtime.pid,
    stopped: true,
  };
}

export function expectScheduledTaskProbeOrigin(params: {
  eventsPath: string;
  probePath: string;
  run: { pid: number; ppid: number };
  scriptPath: string;
  readRelatedProcessDiagnostics: (needles: string[]) => {
    ok: boolean;
    processes: WindowsProcessDiagnostic[];
    truncated: boolean;
  };
}): void {
  expect(params.run.ppid).not.toBe(process.pid);
  const capture = params.readRelatedProcessDiagnostics([
    params.eventsPath,
    params.probePath,
    params.scriptPath,
  ]);
  expect(capture.ok).toBe(true);
  expect(capture.truncated).toBe(false);
  const processEntry = capture.processes.find((entry) => entry.ProcessId === params.run.pid);
  expect(processEntry?.ParentProcessId).toBe(params.run.ppid);
  const normalizeCommandLine = (value: string | null | undefined) =>
    (value ?? "").replaceAll("/", "\\").toLowerCase();
  const processCommandLine = normalizeCommandLine(processEntry?.CommandLine);
  expect(processCommandLine.includes(normalizeCommandLine(params.probePath))).toBe(true);
  expect(processCommandLine.includes(normalizeCommandLine(params.eventsPath))).toBe(true);
  expect(
    capture.processes.some((entry) =>
      normalizeCommandLine(entry.CommandLine).includes(normalizeCommandLine(params.scriptPath)),
    ),
  ).toBe(true);
}
