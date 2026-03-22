import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createConfigIO } from "../config/config.js";
import { isGatewayArgv } from "../infra/gateway-process-argv.js";
import { findVerifiedGatewayListenerPidsOnPortSync } from "../infra/gateway-processes.js";
import { inspectPortUsage } from "../infra/ports.js";
import { killProcessTree } from "../process/kill-tree.js";
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
  return /^[a-zA-Z]:[\\/]/.test(stateDir) || stateDir.startsWith("\\\\")
    ? path.win32.join(stateDir, scriptName)
    : path.join(stateDir, scriptName);
}

function resolveLegacyOsHomeTaskScriptPath(env: GatewayServiceEnv): string | null {
  if (env.OPENCLAW_TASK_SCRIPT?.trim()) {
    return null;
  }
  const legacyEnv: GatewayServiceEnv = { ...env };
  delete legacyEnv.OPENCLAW_HOME;
  delete legacyEnv.OPENCLAW_STATE_DIR;
  delete legacyEnv.CLAWDBOT_STATE_DIR;
  const legacyPath = resolveTaskScriptPath(legacyEnv);
  const currentPath = resolveTaskScriptPath(env);
  return path.resolve(legacyPath) === path.resolve(currentPath) ? null : legacyPath;
}

function resolveTaskScriptCandidates(env: GatewayServiceEnv): string[] {
  const candidates = [resolveTaskScriptPath(env), resolveLegacyOsHomeTaskScriptPath(env)].filter(
    (value): value is string => Boolean(value),
  );
  return Array.from(new Set(candidates.map((value) => path.normalize(value))));
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
  for (const scriptPath of resolveTaskScriptCandidates(env)) {
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
        const lower = line.toLowerCase();
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
      continue;
    }
  }
  return null;
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
  const raw = value.trim().toLowerCase();
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
const UNKNOWN_STATUS_DETAIL =
  "Task status is locale-dependent and no numeric Last Run Result was available.";

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
  const taskName = resolveTaskName(env);
  const res = await execSchtasks(["/Query", "/TN", taskName]).catch(() => ({
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

async function resolveConfiguredGatewayPort(env: GatewayServiceEnv): Promise<number | null> {
  const raw = env.OPENCLAW_GATEWAY_PORT?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  try {
    const io = createConfigIO({ env: { ...env } });
    const snapshot = await io.readConfigFileSnapshot();
    if (!snapshot.exists || !snapshot.valid) {
      return null;
    }
    const configPort = snapshot.config.gateway?.port;
    return typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0
      ? configPort
      : null;
  } catch {
    return null;
  }
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

const TASK_CONFIG_ROOT_ENV_KEYS = [
  "OPENCLAW_CONFIG_PATH",
  "CLAWDBOT_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "CLAWDBOT_STATE_DIR",
  "OPENCLAW_HOME",
] as const;

function resolveTaskConfigEnvironment(
  env: GatewayServiceEnv,
  taskEnvironment?: Record<string, string>,
  sourcePath?: string,
): GatewayServiceEnv {
  if (!taskEnvironment) {
    if (!sourcePath) {
      return env;
    }
    return inferTaskStateDirFromScriptPath(env, sourcePath);
  }
  const mergedEnvironment = { ...env, ...taskEnvironment };
  const hasTaskConfigRoot = TASK_CONFIG_ROOT_ENV_KEYS.some((key) => taskEnvironment[key]?.trim());
  if (hasTaskConfigRoot) {
    const merged: GatewayServiceEnv = { ...env };
    for (const key of TASK_CONFIG_ROOT_ENV_KEYS) {
      delete merged[key];
    }
    return { ...merged, ...taskEnvironment };
  }
  return inferTaskStateDirFromScriptPath(mergedEnvironment, sourcePath);
}

function inferTaskStateDirFromScriptPath(
  env: GatewayServiceEnv,
  sourcePath?: string,
): GatewayServiceEnv {
  if (!sourcePath) {
    return env;
  }
  const currentScriptPath = resolveTaskScriptPath(env);
  if (path.resolve(sourcePath) === path.resolve(currentScriptPath)) {
    return env;
  }
  const merged: GatewayServiceEnv = { ...env };
  for (const key of TASK_CONFIG_ROOT_ENV_KEYS) {
    delete merged[key];
  }
  return {
    ...merged,
    OPENCLAW_STATE_DIR: path.dirname(sourcePath),
  };
}

async function resolveScheduledTaskPort(env: GatewayServiceEnv): Promise<number | null> {
  const command = await readScheduledTaskCommand(env).catch(() => null);
  const taskEnv = resolveTaskConfigEnvironment(env, command?.environment, command?.sourcePath);
  return (
    parsePortFromProgramArguments(command?.programArguments) ??
    parsePositivePort(command?.environment?.OPENCLAW_GATEWAY_PORT) ??
    (await resolveConfiguredGatewayPort(taskEnv))
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
  const taskkillPath = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
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
  const port = (await resolveScheduledTaskPort(env)) ?? (await resolveConfiguredGatewayPort(env));
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

export async function installScheduledTask({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: GatewayServiceInstallArgs): Promise<{ scriptPath: string }> {
  await assertSchtasksAvailable();
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

  const taskName = resolveTaskName(env);
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
  ];
  const taskUser = resolveTaskUser(env);
  let create = await execSchtasks(
    taskUser ? [...baseArgs, "/RU", taskUser, "/NP", "/IT"] : baseArgs,
  );
  if (create.code !== 0 && taskUser) {
    create = await execSchtasks(baseArgs);
  }
  if (create.code !== 0) {
    const detail = create.stderr || create.stdout;
    if (shouldFallbackToStartupEntry({ code: create.code, detail })) {
      const startupEntryPath = resolveStartupEntryPath(env);
      await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
      const launcher = buildStartupLauncherScript({ description: taskDescription, scriptPath });
      await fs.writeFile(startupEntryPath, launcher, "utf8");
      launchFallbackTaskScript(scriptPath);
      writeFormattedLines(
        stdout,
        [
          { label: "Installed Windows login item", value: startupEntryPath },
          { label: "Task script", value: scriptPath },
        ],
        { leadingBlankLine: true },
      );
      return { scriptPath };
    }
    throw new Error(`schtasks create failed: ${detail}`.trim());
  }

  await execSchtasks(["/Run", "/TN", taskName]);
  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    stdout,
    [
      { label: "Installed Scheduled Task", value: taskName },
      { label: "Task script", value: scriptPath },
    ],
    { leadingBlankLine: true },
  );
  return { scriptPath };
}

export async function uninstallScheduledTask({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSchtasksAvailable();
  const taskName = resolveTaskName(env);
  const taskInstalled = await isRegisteredScheduledTask(env).catch(() => false);
  if (taskInstalled) {
    await execSchtasks(["/Delete", "/F", "/TN", taskName]);
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
  const detail = (res.stderr || res.stdout).toLowerCase();
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
  await execSchtasks(["/End", "/TN", taskName]);
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
  const res = await execSchtasks(["/Run", "/TN", taskName]);
  if (res.code !== 0) {
    throw new Error(`schtasks run failed: ${res.stderr || res.stdout}`.trim());
  }
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
    const missing = detail.toLowerCase().includes("cannot find the file");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSchtasksQuery(res.stdout || "");
  const derived = deriveScheduledTaskRuntimeStatus(parsed);
  return {
    status: derived.status,
    state: parsed.status,
    lastRunTime: parsed.lastRunTime,
    lastRunResult: parsed.lastRunResult,
    ...(derived.detail ? { detail: derived.detail } : {}),
  };
}
