import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isGatewayArgv } from "../infra/gateway-process-argv.js";
import { findVerifiedGatewayListenerPidsOnPortSync } from "../infra/gateway-processes.js";
import { inspectPortUsage } from "../infra/ports.js";
import { getWindowsInstallRoots } from "../infra/windows-install-roots.js";
import { killProcessTree } from "../process/kill-tree.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { sleep } from "../utils.js";
import { parseCmdScriptCommandLine, quoteCmdScriptArg } from "./cmd-argv.js";
import { assertNoCmdLineBreak, parseCmdSetAssignment, renderCmdSetAssignment } from "./cmd-set.js";
import { resolveGatewayServiceDescription, resolveGatewayWindowsTaskName } from "./constants.js";
import { formatLine, writeFormattedLines } from "./output.js";
import { resolveGatewayStateDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import { execSchtasks } from "./schtasks-exec.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRenderArgs,
  GatewayServiceRestartResult,
} from "./service-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell helpers (replace schtasks CLI with PowerShell ScheduledTasks API)
// ─────────────────────────────────────────────────────────────────────────────

function isRunningAsAdmin(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    return result.stdout?.trim() === "True";
  } catch {
    return false;
  }
}

interface PowerShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function execPowerShell(script: string, timeoutMs = 15_000): Promise<PowerShellResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", script],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err: Error) => {
      resolve({ code: 1, stdout: "", stderr: String(err) });
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ code: 124, stdout, stderr: "PowerShell timed out after 15s" });
    }, timeoutMs);
  });
}

async function assertPowerShellScheduledTasksAvailable(): Promise<void> {
  const res = await execPowerShell("Get-Command Register-ScheduledTask -Syntax");
  if (res.code === 0) {
    return;
  }
  throw new Error(
    `PowerShell ScheduledTasks module unavailable: ${res.stderr || "unknown error"}`.trim(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function resolveTaskName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

function shouldFallbackToStartupEntry(params: { code: number; detail: string }): boolean {
  return (
    /access is denied/i.test(params.detail) ||
    params.code === 124 ||
    /schtasks timed out/i.test(params.detail) ||
    /schtasks produced no output/i.test(params.detail)
  );
}

export function resolveTaskScriptPath(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_TASK_SCRIPT?.trim();
  if (override) {
    return override;
  }
  const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
  const stateDir = resolveGatewayStateDir(env);
  return path.join(stateDir, scriptName);
}

function resolveWindowsStartupDir(env: GatewayServiceEnv): string {
  const appData = env.APPDATA?.trim();
  if (appData) {
    return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  }
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (!home) {
    throw new Error("Windows startup folder unavailable: APPDATA/USERPROFILE not set");
  }
  return path.join(
    home,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

function sanitizeWindowsFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_").replace(/\p{Cc}/gu, "_");
}

function resolveStartupEntryPath(env: GatewayServiceEnv): string {
  const taskName = resolveTaskName(env);
  return path.join(resolveWindowsStartupDir(env), `${sanitizeWindowsFilename(taskName)}.cmd`);
}

// `/TR` is parsed by schtasks itself, while the generated `gateway.cmd` line is parsed by cmd.exe.
// Keep their quoting strategies separate so each parser gets the encoding it expects.
function quoteSchtasksArg(value: string): string {
  if (!/[ \t"]/g.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function resolveTaskUser(env: GatewayServiceEnv): string | null {
  const username = env.USERNAME || env.USER || env.LOGNAME;
  if (!username) {
    return null;
  }
  if (username.includes("\\")) {
    return username;
  }
  const domain = env.USERDOMAIN;
  if (domain) {
    return `${domain}\\${username}`;
  }
  return username;
}

export async function readScheduledTaskCommand(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    let workingDirectory = "";
    let commandLine = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const lower = normalizeLowercaseStringOrEmpty(line);
      if (line.startsWith("@echo")) {
        continue;
      }
      if (lower.startsWith("rem ")) {
        continue;
      }
      if (lower.startsWith("set ")) {
        const assignment = parseCmdSetAssignment(line.slice(4));
        if (assignment) {
          environment[assignment.key] = assignment.value;
        }
        continue;
      }
      if (lower.startsWith("cd /d ")) {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
        continue;
      }
      commandLine = line;
      break;
    }
    if (!commandLine) {
      return null;
    }
    return {
      programArguments: parseCmdScriptCommandLine(commandLine),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      sourcePath: scriptPath,
    };
  } catch {
    return null;
  }
}

export type ScheduledTaskInfo = {
  status?: string;
  lastRunTime?: string;
  lastRunResult?: string;
};

function hasListenerPid<T extends { pid?: number | null }>(
  listener: T,
): listener is T & { pid: number } {
  return typeof listener.pid === "number";
}

export function parseSchtasksQuery(output: string): ScheduledTaskInfo {
  const entries = parseKeyValueOutput(output, ":");
  const info: ScheduledTaskInfo = {};
  const status = entries.status;
  if (status) {
    info.status = status;
  }
  const lastRunTime = entries["last run time"];
  if (lastRunTime) {
    info.lastRunTime = lastRunTime;
  }
  // Some Windows locales/versions emit "Last Result" instead of "Last Run Result".
  // Accept both so gateway status is not falsely reported as "unknown" (#47726).
  const lastRunResult = entries["last run result"] ?? entries["last result"];
  if (lastRunResult) {
    info.lastRunResult = lastRunResult;
  }
  return info;
}

function normalizeTaskResultCode(value?: string): string | null {
  if (!value) {
    return null;
  }
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (!raw) {
    return null;
  }

  if (/^0x[0-9a-f]+$/.test(raw)) {
    return `0x${raw.slice(2).replace(/^0+/, "") || "0"}`;
  }

  if (/^\d+$/.test(raw)) {
    const numeric = Number.parseInt(raw, 10);
    if (Number.isFinite(numeric)) {
      return `0x${numeric.toString(16)}`;
    }
  }

  return null;
}

const RUNNING_RESULT_CODES = new Set(["0x41301"]);
const NOT_YET_RUN_RESULT_CODES = new Set(["0x41303"]);
const UNKNOWN_STATUS_DETAIL =
  "Task status is locale-dependent and no numeric Last Run Result was available.";
const SCHEDULED_TASK_FALLBACK_POLL_MS = 250;
const SCHEDULED_TASK_FALLBACK_TIMEOUT_MS = 15_000;

export function deriveScheduledTaskRuntimeStatus(parsed: ScheduledTaskInfo): {
  status: GatewayServiceRuntime["status"];
  detail?: string;
} {
  const normalizedResult = normalizeTaskResultCode(parsed.lastRunResult);
  if (normalizedResult != null) {
    if (RUNNING_RESULT_CODES.has(normalizedResult)) {
      return { status: "running" };
    }
    return {
      status: "stopped",
      detail: `Task Last Run Result=${parsed.lastRunResult}; treating as not running.`,
    };
  }
  if (parsed.status?.trim()) {
    return { status: "unknown", detail: UNKNOWN_STATUS_DETAIL };
  }
  return { status: "unknown" };
}

function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const lines: string[] = ["@echo off"];
  const trimmedDescription = description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Task description");
    lines.push(`rem ${trimmedDescription}`);
  }
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (!value) {
        continue;
      }
      if (key.toUpperCase() === "PATH") {
        continue;
      }
      lines.push(renderCmdSetAssignment(key, value));
    }
  }
  const command = programArguments.map(quoteCmdScriptArg).join(" ");
  lines.push(command);
  return `${lines.join("\r\n")}\r\n`;
}

function buildStartupLauncherScript(params: { description?: string; scriptPath: string }): string {
  const lines = ["@echo off"];
  const trimmedDescription = params.description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Startup launcher description");
    lines.push(`rem ${trimmedDescription}`);
  }
  lines.push(`start "" /min cmd.exe /d /c ${quoteCmdScriptArg(params.scriptPath)}`);
  return `${lines.join("\r\n")}\r\n`;
}

async function assertSchtasksAvailable() {
  const res = await execSchtasks(["/Query"]);
  if (res.code === 0) {
    return;
  }
  const detail = res.stderr || res.stdout;
  throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}

async function isStartupEntryInstalled(env: GatewayServiceEnv): Promise<boolean> {
  try {
    await fs.access(resolveStartupEntryPath(env));
    return true;
  } catch {
    return false;
  }
}

async function isRegisteredScheduledTask(env: GatewayServiceEnv): Promise<boolean> {
  // Try PowerShell first (supports newer Task Scheduler API)
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const taskName = resolveTaskName(env);
      const psScript = `Get-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -ErrorAction Stop | ConvertTo-Json -Compress`;
      const res = await execPowerShell(psScript);
      if (res.code === 0 && res.stdout.trim()) {
        return true;
      }
    } catch {
      /* fall through to schtasks */
    }
  }
  // Fall back to schtasks
  const res = await execSchtasks(["/Query", "/TN", resolveTaskName(env)]).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  return res.code === 0;
}

function launchFallbackTaskScript(scriptPath: string): void {
  const child = spawn("cmd.exe", ["/d", "/s", "/c", quoteCmdScriptArg(scriptPath)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function resolveConfiguredGatewayPort(env: GatewayServiceEnv): number | null {
  const raw = env.OPENCLAW_GATEWAY_PORT?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositivePort(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function parsePortFromProgramArguments(programArguments?: string[]): number | null {
  if (!programArguments?.length) {
    return null;
  }
  for (let i = 0; i < programArguments.length; i += 1) {
    const arg = programArguments[i];
    if (!arg) {
      continue;
    }
    const inlineMatch = arg.match(/^--port=(\d+)$/);
    if (inlineMatch) {
      return parsePositivePort(inlineMatch[1]);
    }
    if (arg === "--port") {
      return parsePositivePort(programArguments[i + 1]);
    }
  }
  return null;
}

async function resolveScheduledTaskPort(env: GatewayServiceEnv): Promise<number | null> {
  const command = await readScheduledTaskCommand(env).catch(() => null);
  return (
    parsePortFromProgramArguments(command?.programArguments) ??
    parsePositivePort(command?.environment?.OPENCLAW_GATEWAY_PORT) ??
    resolveConfiguredGatewayPort(env)
  );
}

async function resolveScheduledTaskGatewayListenerPids(port: number): Promise<number[]> {
  const verified = findVerifiedGatewayListenerPidsOnPortSync(port);
  if (verified.length > 0) {
    return verified;
  }

  const diagnostics = await inspectPortUsage(port).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return [];
  }

  const matchedGatewayPids = Array.from(
    new Set(
      diagnostics.listeners
        .filter(
          (listener) =>
            typeof listener.pid === "number" &&
            listener.commandLine &&
            isGatewayArgv(parseCmdScriptCommandLine(listener.commandLine), {
              allowGatewayBinary: true,
            }),
        )
        .map((listener) => listener.pid as number),
    ),
  );
  if (matchedGatewayPids.length > 0) {
    return matchedGatewayPids;
  }

  return Array.from(
    new Set(
      diagnostics.listeners
        .map((listener) => listener.pid)
        .filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0),
    ),
  );
}

async function resolveListenerBackedScheduledTaskRuntime(
  env: GatewayServiceEnv,
): Promise<Pick<GatewayServiceRuntime, "status" | "pid" | "detail"> | null> {
  const port = await resolveScheduledTaskPort(env);
  if (!port) {
    return null;
  }
  const pids = findVerifiedGatewayListenerPidsOnPortSync(port);
  if (pids.length === 0) {
    return null;
  }
  return {
    status: "running",
    pid: pids[0],
    detail: `Verified gateway listener detected on port ${port} even though schtasks did not report a running task.`,
  };
}

async function terminateScheduledTaskGatewayListeners(env: GatewayServiceEnv): Promise<number[]> {
  const port = await resolveScheduledTaskPort(env);
  if (!port) {
    return [];
  }
  const pids = await resolveScheduledTaskGatewayListenerPids(port);
  for (const pid of pids) {
    await terminateGatewayProcessTree(pid, 300);
  }
  return pids;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

async function terminateGatewayProcessTree(pid: number, graceMs: number): Promise<void> {
  if (process.platform !== "win32") {
    killProcessTree(pid, { graceMs });
    return;
  }
  const taskkillPath = path.join(getWindowsInstallRoots().systemRoot, "System32", "taskkill.exe");
  spawnSync(taskkillPath, ["/T", "/PID", String(pid)], {
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  if (await waitForProcessExit(pid, graceMs)) {
    return;
  }
  spawnSync(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  await waitForProcessExit(pid, 5_000);
}

async function waitForGatewayPortRelease(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostics = await inspectPortUsage(port).catch(() => null);
    if (diagnostics?.status === "free") {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function terminateBusyPortListeners(port: number): Promise<number[]> {
  const diagnostics = await inspectPortUsage(port).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return [];
  }
  const pids = Array.from(
    new Set(
      diagnostics.listeners
        .map((listener) => listener.pid)
        .filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0),
    ),
  );
  for (const pid of pids) {
    await terminateGatewayProcessTree(pid, 300);
  }
  return pids;
}

async function resolveFallbackRuntime(env: GatewayServiceEnv): Promise<GatewayServiceRuntime> {
  const port = (await resolveScheduledTaskPort(env)) ?? resolveConfiguredGatewayPort(env);
  if (!port) {
    return {
      status: "unknown",
      detail: "Startup-folder login item installed; gateway port unknown.",
    };
  }
  const diagnostics = await inspectPortUsage(port).catch(() => null);
  if (!diagnostics) {
    return {
      status: "unknown",
      detail: `Startup-folder login item installed; could not inspect port ${port}.`,
    };
  }
  const listener = diagnostics.listeners.find(hasListenerPid);
  return {
    status: diagnostics.status === "busy" ? "running" : "stopped",
    ...(listener?.pid ? { pid: listener.pid } : {}),
    detail:
      diagnostics.status === "busy"
        ? `Startup-folder login item installed; listener detected on port ${port}.`
        : `Startup-folder login item installed; no listener detected on port ${port}.`,
  };
}

async function stopStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  const runtime = await resolveFallbackRuntime(env);
  if (typeof runtime.pid === "number" && runtime.pid > 0) {
    await terminateGatewayProcessTree(runtime.pid, 300);
  }
  stdout.write(`${formatLine("Stopped Windows login item", resolveTaskName(env))}\n`);
}

async function terminateInstalledStartupRuntime(env: GatewayServiceEnv): Promise<void> {
  if (!(await isStartupEntryInstalled(env))) {
    return;
  }
  const runtime = await resolveFallbackRuntime(env);
  if (typeof runtime.pid === "number" && runtime.pid > 0) {
    await terminateGatewayProcessTree(runtime.pid, 300);
  }
}

async function restartStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
): Promise<GatewayServiceRestartResult> {
  const runtime = await resolveFallbackRuntime(env);
  if (typeof runtime.pid === "number" && runtime.pid > 0) {
    await terminateGatewayProcessTree(runtime.pid, 300);
  }
  launchFallbackTaskScript(resolveTaskScriptPath(env));
  stdout.write(`${formatLine("Restarted Windows login item", resolveTaskName(env))}\n`);
  return { outcome: "completed" };
}

async function writeScheduledTaskScript({
  env,
  programArguments,
  workingDirectory,
  environment,
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{
  scriptPath: string;
  taskDescription: string;
}> {
  // PowerShell doesn't require schtasks to be available; check module availability
  if (process.platform === "win32") {
    await assertPowerShellScheduledTasksAvailable().catch(() => {
      /* ignore; will fail at activate time */
    });
  }
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const taskDescription = resolveGatewayServiceDescription({ env, environment, description });
  const script = buildTaskScript({
    description: taskDescription,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(scriptPath, script, "utf8");
  return { scriptPath, taskDescription };
}

export async function stageScheduledTask({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ scriptPath: string }> {
  const { scriptPath } = await writeScheduledTaskScript(args);
  writeFormattedLines(stdout, [{ label: "Staged task script", value: scriptPath }], {
    leadingBlankLine: true,
  });
  return { scriptPath };
}

async function updateExistingScheduledTask(params: {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  taskName: string;
  quotedScript: string;
  scriptPath: string;
}): Promise<boolean> {
  if (!(await isRegisteredScheduledTask(params.env))) {
    return false;
  }

  // Try PowerShell first
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const safePath = params.scriptPath.replace(/'/g, "''");
      const safeName = params.taskName.replace(/'/g, "''");
      const psScript = [
        `$task = Get-ScheduledTask -TaskName '${safeName}' -ErrorAction Stop`,
        `$task.Actions = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/d /s /c ''${safePath}'''`,
        `$task | Register-ScheduledTask -TaskName '${safeName}' -Force -ErrorAction Stop`,
      ].join("; ");
      const updateRes = await execPowerShell(psScript);
      if (updateRes.code === 0) {
        await runScheduledTaskOrThrow({ taskName: params.taskName, env: params.env, scriptPath: params.scriptPath });
        writeFormattedLines(
          params.stdout,
          [
            { label: "Updated Scheduled Task", value: params.taskName },
            { label: "Task script", value: params.scriptPath },
          ],
          { leadingBlankLine: true },
        );
        return true;
      }
    } catch {
      /* fall through to schtasks */
    }
  }

  // Fall back to schtasks /Change
  const change = await execSchtasks([
    "/Change",
    "/TN",
    params.taskName,
    "/TR",
    params.quotedScript,
  ]);
  if (change.code !== 0) {
    return false;
  }
  await runScheduledTaskOrThrow({
    taskName: params.taskName,
    env: params.env,
    scriptPath: params.scriptPath,
  });
  writeFormattedLines(
    params.stdout,
    [
      { label: "Updated Scheduled Task", value: params.taskName },
      { label: "Task script", value: params.scriptPath },
    ],
    { leadingBlankLine: true },
  );
  return true;
}

async function shouldFallbackScheduledTaskLaunch(params: {
  env: GatewayServiceEnv;
  scriptPath: string;
}): Promise<boolean> {
  const readLaunchObservation = async (): Promise<{
    state: "running" | "not-yet-run" | "other";
    signature: string;
  }> => {
    const runtime = await readScheduledTaskRuntime(params.env).catch(() => null);
    if (runtime?.status === "running") {
      return {
        state: "running",
        signature: [runtime.state, runtime.lastRunTime, runtime.lastRunResult, runtime.detail]
          .filter(Boolean)
          .join("|"),
      };
    }
    const normalizedResult = normalizeTaskResultCode(runtime?.lastRunResult);
    if (normalizedResult && NOT_YET_RUN_RESULT_CODES.has(normalizedResult)) {
      return {
        state: "not-yet-run",
        signature: [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
          .filter(Boolean)
          .join("|"),
      };
    }
    return {
      state: "other",
      signature: [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
        .filter(Boolean)
        .join("|"),
    };
  };

  const hasLaunchEvidence = async (): Promise<boolean> => {
    const port = await resolveScheduledTaskPort(params.env);
    if (port) {
      const listenerPids = await resolveScheduledTaskGatewayListenerPids(port);
      if (listenerPids.length > 0) {
        return true;
      }
    }

    if (process.platform !== "win32") {
      return false;
    }

    const scriptPathNeedle = normalizeLowercaseStringOrEmpty(
      params.scriptPath.replaceAll("/", "\\"),
    );
    if (!scriptPathNeedle) {
      return false;
    }

    const processSnapshot = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        timeout: 1_500,
        windowsHide: true,
      },
    );
    if (processSnapshot.error || processSnapshot.status !== 0) {
      return false;
    }

    type WindowsProcessSnapshotEntry = {
      ProcessId?: number;
      CommandLine?: string | null;
    };

    let parsedSnapshot: unknown;
    try {
      parsedSnapshot = JSON.parse(processSnapshot.stdout.trim() || "[]");
    } catch {
      return false;
    }

    const entries = (Array.isArray(parsedSnapshot) ? parsedSnapshot : [parsedSnapshot]).filter(
      (entry): entry is WindowsProcessSnapshotEntry => typeof entry === "object" && entry !== null,
    );
    const matchingTaskScriptProcess = entries.some((entry) =>
      normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "")
        .replaceAll("/", "\\")
        .includes(scriptPathNeedle),
    );
    if (matchingTaskScriptProcess) {
      return true;
    }

    if (!port) {
      return false;
    }

    return entries.some((entry) => {
      const commandLine = normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "");
      if (!commandLine) {
        return false;
      }
      const argv = parseCmdScriptCommandLine(entry.CommandLine ?? "");
      if (!isGatewayArgv(argv, { allowGatewayBinary: true })) {
        return false;
      }
      return parsePortFromProgramArguments(argv) === port;
    });
  };

  const initial = await readLaunchObservation();
  if (initial.state !== "not-yet-run") {
    return false;
  }

  const deadline = Date.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SCHEDULED_TASK_FALLBACK_POLL_MS);
    const current = await readLaunchObservation();
    if (current.state !== "not-yet-run") {
      return false;
    }
    if (current.signature !== initial.signature) {
      return false;
    }
  }
  return !(await hasLaunchEvidence());
}

async function runScheduledTaskOrThrow(params: {
  taskName: string;
  env: GatewayServiceEnv;
  scriptPath: string;
}): Promise<void> {
  // Try PowerShell first
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const safeName = params.taskName.replace(/'/g, "''");
      const psScript = `Start-ScheduledTask -TaskName '${safeName}' -ErrorAction Stop`;
      const runRes = await execPowerShell(psScript);
      if (runRes.code === 0) {
        if (
          !(await shouldFallbackScheduledTaskLaunch({ env: params.env, scriptPath: params.scriptPath }))
        ) {
          return;
        }
        launchFallbackTaskScript(params.scriptPath);
        return;
      }
    } catch {
      /* fall through to schtasks */
    }
  }

  // Fall back to schtasks /Run
  const run = await execSchtasks(["/Run", "/TN", params.taskName]);
  if (run.code !== 0) {
    throw new Error(`schtasks run failed: ${run.stderr || run.stdout}`.trim());
  }
  if (
    !(await shouldFallbackScheduledTaskLaunch({ env: params.env, scriptPath: params.scriptPath }))
  ) {
    return;
  }
  launchFallbackTaskScript(params.scriptPath);
}

async function activateScheduledTask(params: {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  scriptPath: string;
  description?: string;
}) {
  const taskDescription = params.description ?? "OpenClaw Gateway";
  const taskName = resolveTaskName(params.env);
  const scriptPath = params.scriptPath;
  const safeScriptPath = scriptPath.replace(/'/g, "''");
  const safeTaskName = taskName.replace(/'/g, "''");
  const safeTaskDesc = taskDescription.replace(/'/g, "''");

  // ── Administrator privilege check ────────────────────────────────────────
  // Register-ScheduledTask requires admin privileges.
  // If not admin, throw an explicit error instead of silently falling back to Startup folder.
  if (process.platform === "win32" && !isRunningAsAdmin()) {
    throw new Error(
      `Administrator privileges required to register a Windows Scheduled Task for auto-start.\n` +
        `Please run the command with administrator privileges and try again.\n` +
        `(Register-ScheduledTask requires elevation; falling back to Startup folder is disabled for safety.)`,
    );
  }

  // ── Try updating existing task ──────────────────────────────────────────────
  if (await updateExistingScheduledTask({ ...params, taskName, quotedScript: quoteSchtasksArg(scriptPath), scriptPath })) {
    return;
  }

  // ── Use PowerShell Register-ScheduledTask as primary method ─────────────────
  // Key advantages over schtasks:
  //   - ExecutionTimeLimit 0  → disables 72-hour auto-stop
  //   - AllowStartIfOnBatteries + DontStopIfGoingOnBatteries → allow battery power
  //   - No need for /I idle-time parameter
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const psScript = [
        `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
        `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/d /s /c ''${safeScriptPath}'''`,
        `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -StartWhenAvailable`,
        `$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited`,
        `Register-ScheduledTask -TaskName '${safeTaskName}' -Trigger $trigger -Action $action -Settings $settings -Principal $principal -Description '${safeTaskDesc}' -Force`,
        `Start-ScheduledTask -TaskName '${safeTaskName}'`,
      ].join("; ");
      const createRes = await execPowerShell(psScript);
      if (createRes.code === 0) {
        writeFormattedLines(
          params.stdout,
          [
            { label: "Installed Scheduled Task (PowerShell)", value: taskName },
            { label: "Task script", value: scriptPath },
          ],
          { leadingBlankLine: true },
        );
        return;
      }
      // Check if it was an access-denied error (e.g., elevation lost)
      const detail = createRes.stderr || createRes.stdout;
      if (/access is denied|permissiondenied|0x80070005/i.test(detail)) {
        throw new Error(
          `Register-ScheduledTask failed (access denied): ${detail}\n` +
            `Administrator privileges may have been revoked. Please re-run with administrator privileges.`,
        );
      }
      // Non-privilege error — fall through to schtasks
    } catch (err) {
      // Re-throw structured admin-privilege errors
      if (err instanceof Error && err.message?.includes("Administrator privileges")) {
        throw err;
      }
      // Other errors (PowerShell unavailable, etc.) — fall through to schtasks
    }
  }

  // ── Fall back to schtasks (only when PowerShell module is unavailable) ───────
  await assertSchtasksAvailable();
  const quotedScript = quoteSchtasksArg(scriptPath);
  const baseArgs = [
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    taskName,
    "/TR",
    quotedScript,
    "/I",
    "0", // Disable idle-wait condition
  ];
  const taskUser = resolveTaskUser(params.env);
  let create = await execSchtasks(
    taskUser ? [...baseArgs, "/RU", taskUser, "/NP", "/IT"] : baseArgs,
  );
  if (create.code !== 0 && taskUser) {
    create = await execSchtasks(baseArgs);
  }
  if (create.code !== 0) {
    const detail = create.stderr || create.stdout;
    if (shouldFallbackToStartupEntry({ code: create.code, detail })) {
      const startupEntryPath = resolveStartupEntryPath(params.env);
      await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
      const launcher = buildStartupLauncherScript({
        description: taskDescription,
        scriptPath,
      });
      await fs.writeFile(startupEntryPath, launcher, "utf8");
      launchFallbackTaskScript(scriptPath);
      writeFormattedLines(
        params.stdout,
        [
          { label: "Installed Windows login item", value: startupEntryPath },
          { label: "Task script", value: scriptPath },
        ],
        { leadingBlankLine: true },
      );
      return;
    }
    throw new Error(`schtasks create failed: ${detail}`.trim());
  }

  await runScheduledTaskOrThrow({
    taskName,
    env: params.env,
    scriptPath,
  });
  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    params.stdout,
    [
      { label: "Installed Scheduled Task", value: taskName },
      { label: "Task script", value: scriptPath },
    ],
    { leadingBlankLine: true },
  );
}

export async function installScheduledTask(
  args: GatewayServiceInstallArgs,
): Promise<{ scriptPath: string }> {
  const staged = await writeScheduledTaskScript(args);
  await activateScheduledTask({
    env: args.env,
    stdout: args.stdout,
    scriptPath: staged.scriptPath,
    description: staged.taskDescription,
  });
  return { scriptPath: staged.scriptPath };
}

export async function uninstallScheduledTask({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  const taskName = resolveTaskName(env);

  // Try PowerShell first
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const safeName = taskName.replace(/'/g, "''");
      const psScript = `Unregister-ScheduledTask -TaskName '${safeName}' -Confirm:$false -ErrorAction Stop`;
      const psRes = await execPowerShell(psScript);
      if (psRes.code === 0) {
        stdout.write(`${formatLine("Removed Scheduled Task (PowerShell)", taskName)}\n`);
      }
    } catch {
      /* schtasks fallback */
    }
  }

  // Fall back to schtasks /Delete
  try {
    await assertSchtasksAvailable();
  } catch {
    /* schtasks unavailable */
  }
  const taskInstalled = await isRegisteredScheduledTask(env).catch(() => false);
  if (taskInstalled) {
    await execSchtasks(["/Delete", "/F", "/TN", taskName]).catch(() => {/* ignore */});
  }

  const startupEntryPath = resolveStartupEntryPath(env);
  try {
    await fs.unlink(startupEntryPath);
    stdout.write(`${formatLine("Removed Windows login item", startupEntryPath)}\n`);
  } catch {}

  const scriptPath = resolveTaskScriptPath(env);
  try {
    await fs.unlink(scriptPath);
    stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }
}

function isTaskNotRunning(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return detail.includes("not running");
}

export async function stopScheduledTask({ stdout, env }: GatewayServiceControlArgs): Promise<void> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      await stopStartupEntry(effectiveEnv, stdout);
      return;
    }
    throw err;
  }
  if (!(await isRegisteredScheduledTask(effectiveEnv))) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      await stopStartupEntry(effectiveEnv, stdout);
      return;
    }
  }
  const taskName = resolveTaskName(effectiveEnv);

  // Try PowerShell first
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const safeName = taskName.replace(/'/g, "''");
      const psRes = await execPowerShell(`Stop-ScheduledTask -TaskName '${safeName}' -ErrorAction Stop`);
      if (psRes.code === 0) {
        writeFormattedLines(stdout, [{ label: "Stopped Scheduled Task (PowerShell)", value: taskName }], {
          leadingBlankLine: true,
        });
        const stopPort = await resolveScheduledTaskPort(effectiveEnv);
        await terminateScheduledTaskGatewayListeners(effectiveEnv);
        await terminateInstalledStartupRuntime(effectiveEnv);
        if (stopPort) {
          const released = await waitForGatewayPortRelease(stopPort);
          if (!released) {
            await terminateBusyPortListeners(stopPort);
            const releasedAfterForce = await waitForGatewayPortRelease(stopPort, 2_000);
            if (!releasedAfterForce) {
              throw new Error(`gateway port ${stopPort} is still busy after stop`);
            }
          }
        }
        return;
      }
    } catch {
      /* fall through to schtasks */
    }
  }

  // Fall back to schtasks /End
  const res = await execSchtasks(["/End", "/TN", taskName]);
  if (res.code !== 0 && !isTaskNotRunning(res)) {
    throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
  }
  const stopPort = await resolveScheduledTaskPort(effectiveEnv);
  await terminateScheduledTaskGatewayListeners(effectiveEnv);
  await terminateInstalledStartupRuntime(effectiveEnv);
  if (stopPort) {
    const released = await waitForGatewayPortRelease(stopPort);
    if (!released) {
      await terminateBusyPortListeners(stopPort);
      const releasedAfterForce = await waitForGatewayPortRelease(stopPort, 2_000);
      if (!releasedAfterForce) {
        throw new Error(`gateway port ${stopPort} is still busy after stop`);
      }
    }
  }
  stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
}

export async function restartScheduledTask({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      return await restartStartupEntry(effectiveEnv, stdout);
    }
    throw err;
  }
  if (!(await isRegisteredScheduledTask(effectiveEnv))) {
    if (await isStartupEntryInstalled(effectiveEnv)) {
      return await restartStartupEntry(effectiveEnv, stdout);
    }
  }
  const taskName = resolveTaskName(effectiveEnv);

  // Try PowerShell Stop + Start
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const safeName = taskName.replace(/'/g, "''");
      await execPowerShell(`Stop-ScheduledTask -TaskName '${safeName}' -ErrorAction Stop`).catch(
        () => {/* ignore stop errors */},
      );
    } catch {
      /* fall through to schtasks End */
    }
  } else {
    await execSchtasks(["/End", "/TN", taskName]).catch(() => {/* ignore */});
  }

  const restartPort = await resolveScheduledTaskPort(effectiveEnv);
  await terminateScheduledTaskGatewayListeners(effectiveEnv);
  await terminateInstalledStartupRuntime(effectiveEnv);
  if (restartPort) {
    const released = await waitForGatewayPortRelease(restartPort);
    if (!released) {
      await terminateBusyPortListeners(restartPort);
      const releasedAfterForce = await waitForGatewayPortRelease(restartPort, 2_000);
      if (!releasedAfterForce) {
        throw new Error(`gateway port ${restartPort} is still busy before restart`);
      }
    }
  }

  await runScheduledTaskOrThrow({
    taskName,
    env: effectiveEnv,
    scriptPath: resolveTaskScriptPath(effectiveEnv),
  });
  stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
  return { outcome: "completed" };
}

export async function isScheduledTaskInstalled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const effectiveEnv = args.env ?? (process.env as GatewayServiceEnv);
  if (await isRegisteredScheduledTask(effectiveEnv)) {
    return true;
  }
  return await isStartupEntryInstalled(effectiveEnv);
}

export async function readScheduledTaskRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  // Try PowerShell first
  if (process.platform === "win32") {
    try {
      await assertPowerShellScheduledTasksAvailable();
      const taskName = resolveTaskName(env);
      const safeName = taskName.replace(/'/g, "''");
      const psScript = [
        `$task = Get-ScheduledTask -TaskName '${safeName}' -ErrorAction Stop`,
        `$info = Get-ScheduledTaskInfo -TaskName '${safeName}' -ErrorAction Stop`,
        `@{$taskState=$task.State;$lastRunTime=$info.LastRunTime;$lastResult=$info.LastTaskResult;$nextRunTime=$info.NextRunTime} | ConvertTo-Json -Compress`,
      ].join("; ");
      const res = await execPowerShell(psScript);
      if (res.code === 0 && res.stdout.trim()) {
        try {
          const parsed = JSON.parse(res.stdout.trim());
          const normalizedResult = normalizeTaskResultCode(String(parsed.lastResult ?? ""));
          const derived =
            normalizedResult != null
              ? RUNNING_RESULT_CODES.has(normalizedResult)
                ? { status: "running" as const }
                : {
                    status: "stopped" as const,
                    detail: `Task Last Run Result=${parsed.lastResult}; treating as not running.`,
                  }
              : parsed.taskState === "Running"
                ? { status: "running" as const }
                : { status: "unknown" as const, detail: UNKNOWN_STATUS_DETAIL };
          return {
            status: derived.status,
            state: parsed.taskState,
            lastRunTime: parsed.lastRunTime,
            lastRunResult: parsed.lastResult,
            nextRunTime: parsed.nextRunTime,
            ...(derived.detail ? { detail: derived.detail } : {}),
          };
        } catch {
          /* JSON parse failed */
        }
      }
    } catch {
      /* PowerShell failed, fall through to schtasks */
    }
  }

  // Fall back to schtasks
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    if (await isStartupEntryInstalled(env)) {
      return await resolveFallbackRuntime(env);
    }
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const taskName = resolveTaskName(env);
  const res = await execSchtasks(["/Query", "/TN", taskName, "/V", "/FO", "LIST"]);
  if (res.code !== 0) {
    if (await isStartupEntryInstalled(env)) {
      return await resolveFallbackRuntime(env);
    }
    const detail = (res.stderr || res.stdout).trim();
    const missing = normalizeLowercaseStringOrEmpty(detail).includes("cannot find the file");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSchtasksQuery(res.stdout || "");
  const derived = deriveScheduledTaskRuntimeStatus(parsed);
  if (derived.status !== "running") {
    const observedRuntime = await resolveListenerBackedScheduledTaskRuntime(env);
    if (observedRuntime) {
      return {
        ...observedRuntime,
        state: parsed.status,
        lastRunTime: parsed.lastRunTime,
        lastRunResult: parsed.lastRunResult,
      };
    }
  }
  return {
    status: derived.status,
    state: parsed.status,
    lastRunTime: parsed.lastRunTime,
    lastRunResult: parsed.lastRunResult,
    ...(derived.detail ? { detail: derived.detail } : {}),
  };
}
