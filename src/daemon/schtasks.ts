import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPortUsage } from "../infra/ports.js";
import { killProcessTree } from "../process/kill-tree.js";
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
    return null;
  }
}

export type ScheduledTaskInfo = {
  status?: string;
  lastRunTime?: string;
  lastRunResult?: string;
};

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
  const lastRunResult = entries["last run result"];
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

function resolveConfiguredGatewayPort(env: GatewayServiceEnv): number | null {
  const raw = env.OPENCLAW_GATEWAY_PORT?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function resolveFallbackRuntime(env: GatewayServiceEnv): Promise<GatewayServiceRuntime> {
  const port = resolveConfiguredGatewayPort(env);
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
  const listener = diagnostics.listeners.find((item) => typeof item.pid === "number");
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
    killProcessTree(runtime.pid, { graceMs: 300 });
  }
  stdout.write(`${formatLine("Stopped Windows login item", resolveTaskName(env))}\n`);
}

async function restartStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
): Promise<GatewayServiceRestartResult> {
  const runtime = await resolveFallbackRuntime(env);
  if (typeof runtime.pid === "number" && runtime.pid > 0) {
    killProcessTree(runtime.pid, { graceMs: 300 });
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
