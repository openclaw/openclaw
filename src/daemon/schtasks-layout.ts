import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeProfileName } from "../cli/profile-utils.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { getWindowsCmdExePath, getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  parseCmdScriptCommandLine,
  quoteCmdScriptArg,
  stripTrailingCmdRedirections,
} from "./cmd-argv.js";
import { assertNoCmdLineBreak, parseCmdSetAssignment, renderCmdSetAssignment } from "./cmd-set.js";
import { normalizeWindowsTaskIdentity, resolveGatewayWindowsTaskName } from "./constants.js";
import { resolveGatewayTaskScriptPath as resolveTaskScriptPath } from "./paths.js";
import { assertTaskInspectionDeadline, readTaskFile } from "./schtasks-inspection-deadline.js";
import {
  isScheduledTaskDefinitionAbsent,
  probeScheduledTaskState,
  ScheduledTaskInspectionError,
} from "./schtasks-state-probe.js";
import { resolveWindowsServiceCommandProfile } from "./service-env-merge.js";
import { ServiceInspectionError } from "./service-inspection-error.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceCommandSnapshot,
  GatewayServiceEnv,
  GatewayServiceReadOptions,
  GatewayServiceRenderArgs,
} from "./service-types.js";
import {
  WINDOWS_TASK_LAUNCHER_ACTIVE,
  WINDOWS_TASK_LAUNCHER_ENV,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./windows-task-supervisor-contract.js";

export function resolveTaskName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

// Keeps the service gateway's stdin off the (possibly hidden) console so TTY
// heuristics fail closed for permission prompts (#112173).
const STDIN_NUL_REDIRECT = "< NUL";
const DIRECT_TASK_LAUNCHER_MARKER = `if not defined ${WINDOWS_TASK_LAUNCHER_ENV} set "${WINDOWS_TASK_LAUNCHER_ENV}=cmd"`;

export function shouldFallbackToStartupEntry(params: { code: number; detail: string }): boolean {
  // Permission failures and hung schtasks calls can use the per-user Startup fallback.
  return (
    params.code === 1 ||
    /(?:access is denied|acceso denegado)/i.test(params.detail) ||
    params.code === 124 ||
    /schtasks timed out/i.test(params.detail) ||
    /schtasks produced no output/i.test(params.detail)
  );
}

function resolveWindowsStartupDir(env: GatewayServiceEnv): string {
  let appData = env.APPDATA?.trim();
  if (!appData) {
    const home = env.USERPROFILE?.trim() || env.HOME?.trim();
    if (!home) {
      throw new Error("Windows startup folder unavailable: APPDATA/USERPROFILE not set");
    }
    appData = path.join(home, "AppData", "Roaming");
  }
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function resolveStartupEntryPath(env: GatewayServiceEnv, extension?: "cmd" | "vbs"): string {
  const taskName = resolveTaskName(env)
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\p{Cc}/gu, "_");
  const entryExtension = extension ?? (shouldUseHiddenWindowsTaskLauncher(env) ? "vbs" : "cmd");
  return path.join(resolveWindowsStartupDir(env), `${taskName}.${entryExtension}`);
}

export function resolveStartupEntryPaths(env: GatewayServiceEnv): string[] {
  const primaryPath = resolveStartupEntryPath(env);
  const legacyCmdPath = resolveStartupEntryPath(env, "cmd");
  const hiddenLauncherPath = resolveStartupEntryPath(env, "vbs");
  // Lifecycle operations must find both launcher variants even without the persisted marker.
  return uniqueStrings([primaryPath, legacyCmdPath, hiddenLauncherPath]);
}

// schtasks `/TR` and cmd.exe parse different surfaces, so keep their quoting separate.
export function quoteSchtasksArg(value: string): string {
  if (!/[ \t"]/g.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function shouldUseHiddenWindowsTaskLauncher(env: GatewayServiceEnv): boolean {
  const value = normalizeLowercaseStringOrEmpty(env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER);
  return value === "1" || value === "true" || value === "yes";
}

type LauncherContentObserver = (content: string, sourcePath: string) => void;

export function resolveTaskLauncherScriptPath(env: GatewayServiceEnv, scriptPath: string): string {
  if (!shouldUseHiddenWindowsTaskLauncher(env)) {
    return scriptPath;
  }
  const parsed = path.parse(scriptPath);
  return path.join(parsed.dir, `${parsed.name}.vbs`);
}

function assertStaticTaskPath(value: string): void {
  if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(value) || /[%\r\n"]/.test(value)) {
    throw new Error("Scheduled Task launcher path is not absolute and literal");
  }
}

async function readTaskLauncher(
  launcherPath: string,
  onLauncherContent?: LauncherContentObserver,
  startup = false,
  deadline?: number,
): Promise<{ scriptPath: string; content?: string }> {
  assertTaskInspectionDeadline(deadline);
  assertStaticTaskPath(launcherPath);
  if (/\.(?:cmd|bat)$/i.test(launcherPath) && !startup) {
    return { scriptPath: launcherPath };
  }
  if (!/\.(?:vbs|cmd)$/i.test(launcherPath)) {
    throw new Error("Unsupported Scheduled Task action");
  }
  const content = await readTaskFile(launcherPath, deadline);
  onLauncherContent?.(content, launcherPath);
  const cmd = /\.cmd$/i.test(launcherPath);
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !(cmd ? /^rem /i.test(line) : line.startsWith("'")));
  if (cmd && lines[0]?.toLowerCase() === "@echo off") {
    lines.shift();
  }
  const body = lines.join("\n");
  if (cmd) {
    const args = parseCmdScriptCommandLine(/^start "" \/min (.+)$/i.exec(body)?.[1] ?? "");
    const scriptPath = args[3];
    if (
      args.length !== 4 ||
      ![getWindowsCmdExePath().toLowerCase(), "cmd.exe"].includes(args[0]?.toLowerCase() ?? "") ||
      args[1]?.toLowerCase() !== "/d" ||
      args[2]?.toLowerCase() !== "/c" ||
      !scriptPath ||
      !/\.cmd$/i.test(scriptPath) ||
      stripTrailingCmdRedirections(body) !== body
    ) {
      throw new Error("Unrecognized Startup launcher");
    }
    assertStaticTaskPath(scriptPath);
    return { scriptPath, content };
  }
  const current =
    /^Set shell = CreateObject\("WScript\.Shell"\)\n(?:shell\.Environment\("Process"\)\("OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER"\) = "wscript"\n)?WScript\.Quit shell\.Run\("((?:""|[^"])*)", 0, True\)$/i.exec(
      body,
    );
  // v2026.9.2 and v2026.9.3 generated a direct synchronous wrapper.
  const synchronous =
    /^WScript\.Quit CreateObject\("WScript\.Shell"\)\.Run\("((?:""|[^"])*)", 0, True\)$/i.exec(
      body,
    );
  const legacy = /^CreateObject\("WScript\.Shell"\)\.Run "((?:""|[^"])*)", 0, False$/i.exec(body);
  const quotedPath = (current ?? synchronous ?? legacy)?.[1]?.replaceAll('""', '"');
  if (!quotedPath || !/^"[^"]+\.cmd"$/i.test(quotedPath)) {
    throw new Error("Unrecognized Scheduled Task launcher");
  }
  const scriptPath = quotedPath.slice(1, -1);
  assertStaticTaskPath(scriptPath);
  return { scriptPath, content };
}

async function readTaskLaunchers(
  env: GatewayServiceEnv,
  actionPath?: string,
  onLauncherContent?: LauncherContentObserver,
  deadline?: number,
) {
  const launchers: Array<{ pathname: string; scriptPath: string; content?: string }> = [];
  for (const pathname of actionPath === undefined ? resolveStartupEntryPaths(env) : [actionPath]) {
    try {
      launchers.push({
        pathname,
        ...(await readTaskLauncher(
          pathname,
          onLauncherContent,
          actionPath === undefined,
          deadline,
        )),
      });
    } catch (error) {
      if (actionPath !== undefined || !hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  if (
    new Set(launchers.map(({ scriptPath }) => path.win32.normalize(scriptPath).toLowerCase()))
      .size > 1
  ) {
    throw new Error("Startup launchers select different Gateway scripts");
  }
  return launchers;
}

export async function readScheduledTaskCommand(
  env: GatewayServiceEnv,
  options?: GatewayServiceReadOptions & {
    onLauncherContent?: LauncherContentObserver;
    /** Inventory reads a Task's profile without admitting it as the caller's selected service. */
    profileScope?: "registered";
    /** Shared monotonic deadline for aggregate Windows inventory. */
    deadline?: number;
  },
): Promise<GatewayServiceCommandConfig | null> {
  try {
    const command = await readWindowsTaskCommand({ kind: "scheduled-task", env }, options);
    options?.onCommandInspection?.(command ? { kind: "present", command } : { kind: "absent" });
    return command;
  } catch (error) {
    options?.onCommandInspection?.({ kind: "unavailable", error });
    throw error;
  }
}

export async function readStartupEntryCommand(
  startupEntryPath: string,
  options?: { onLauncherContent?: LauncherContentObserver; deadline?: number },
): Promise<GatewayServiceCommandConfig> {
  const command = await readWindowsTaskCommand(
    { kind: "startup-entry", path: startupEntryPath },
    { ...options, requireEffective: true },
  );
  if (!command) {
    throw new Error("Startup service command could not be inspected.");
  }
  return command;
}

async function readWindowsTaskCommand(
  target:
    | { kind: "scheduled-task"; env: GatewayServiceEnv }
    | { kind: "startup-entry"; path: string },
  options?: GatewayServiceReadOptions & {
    onLauncherContent?: LauncherContentObserver;
    profileScope?: "registered";
    deadline?: number;
  },
): Promise<GatewayServiceCommandConfig | null> {
  const env = target.kind === "scheduled-task" ? target.env : {};
  const startupEntryPath = target.kind === "startup-entry" ? target.path : undefined;
  const requireEffective = options?.requireEffective || options?.requireLoaded;
  const timeoutDeadline =
    options?.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
  const deadline =
    options?.deadline === undefined
      ? timeoutDeadline
      : timeoutDeadline === undefined
        ? options.deadline
        : Math.min(options.deadline, timeoutDeadline);
  const remainingTimeout = () =>
    deadline === undefined ? undefined : deadline - performance.now();
  const assertInspectionDeadline = () => assertTaskInspectionDeadline(deadline);
  try {
    assertInspectionDeadline();
    const taskName = resolveTaskName(env);
    const registered =
      target.kind === "scheduled-task" && options?.requireLoaded
        ? probeScheduledTaskState(taskName, remainingTimeout())
        : undefined;
    if (registered?.status === "unknown") {
      throw new ScheduledTaskInspectionError(registered);
    }
    assertInspectionDeadline();
    const assertCommandProfile = (command: GatewayServiceCommandConfig) => {
      if (!registered || options?.profileScope === "registered") {
        return;
      }
      const profile = resolveWindowsServiceCommandProfile(command);
      if (
        profile.kind === "unavailable" ||
        profile.profile !==
          (normalizeProfileName(resolveEnvironmentValue(env, "OPENCLAW_PROFILE", "win32")) ??
            "default")
      ) {
        throw new Error("Scheduled Task selector changed during inspection");
      }
    };
    const action = registered?.status === "found" ? registered.actions?.[0] : undefined;
    if (
      registered?.status === "found" &&
      normalizeWindowsTaskIdentity(registered.taskPath ?? "") ===
        normalizeWindowsTaskIdentity(taskName) &&
      registered.actions &&
      registered.actions.length > 1 &&
      options?.onLauncherContent
    ) {
      // Inventory needs evidence from later custom actions even though a multi-action
      // task cannot supply one effective Gateway command or lifecycle authority.
      for (const candidate of registered.actions) {
        if (candidate.type !== 0) {
          continue;
        }
        const argv = [
          candidate.path,
          ...splitArgsPreservingQuotes(candidate.arguments, { escapeMode: "backslash-quote-only" }),
        ];
        for (const pathname of argv.filter((arg) => /\.(?:bat|cmd|vbs)$/i.test(arg))) {
          try {
            assertStaticTaskPath(pathname);
            const scriptPath = /\.bat$/i.test(pathname)
              ? pathname
              : (await readTaskLauncher(pathname, options.onLauncherContent, false, deadline))
                  .scriptPath;
            options.onLauncherContent(await readTaskFile(scriptPath, deadline), scriptPath);
          } catch {
            assertInspectionDeadline();
          }
        }
      }
    }
    if (
      registered?.status === "found" &&
      (!registered.taskPath ||
        normalizeWindowsTaskIdentity(registered.taskPath) !==
          normalizeWindowsTaskIdentity(taskName) ||
        registered.actions?.length !== 1 ||
        action?.type !== 0)
    ) {
      throw new Error("Scheduled Task action cannot be inspected");
    }
    if (action?.workingDirectory) {
      assertStaticTaskPath(action.workingDirectory);
    }
    const cmdLauncher =
      action && action.path.toLowerCase() === getWindowsCmdExePath(env).toLowerCase()
        ? /^\/d \/s \/c ""([^"%\r\n]+\.(?:cmd|bat))""$/i.exec(action.arguments.trim())?.[1]
        : undefined;
    const wscriptLauncher =
      action &&
      ["wscript.exe", getWindowsSystem32ExePath("wscript.exe", env).toLowerCase()].includes(
        action.path.toLowerCase(),
      )
        ? /^"([^"%\r\n]+\.vbs)"$/i.exec(action.arguments.trim())?.[1]
        : undefined;
    const registeredLauncher = cmdLauncher ?? wscriptLauncher;
    const directExecutable = action && !registeredLauncher && /\.exe$/i.test(action.path);
    if (action && !directExecutable && !registeredLauncher && action.arguments.trim()) {
      throw new Error("Scheduled Task launcher arguments cannot be inspected");
    }
    const captureLaunchers = async (onContent?: LauncherContentObserver) =>
      startupEntryPath !== undefined
        ? [
            {
              pathname: startupEntryPath,
              ...(await readTaskLauncher(startupEntryPath, onContent, true, deadline)),
            },
          ]
        : readTaskLaunchers(env, registeredLauncher ?? action?.path, onContent, deadline);
    const launchers =
      (registered && !directExecutable) || startupEntryPath !== undefined
        ? await captureLaunchers(options?.onLauncherContent)
        : undefined;
    const assertRegistrationCurrent = async (source?: { path: string; content: string }) => {
      if (!registered && !launchers) {
        return;
      }
      if (
        (launchers && !isDeepStrictEqual(await captureLaunchers(), launchers)) ||
        (source && (await readTaskFile(source.path, deadline)) !== source.content)
      ) {
        throw new Error("Task launcher changed during inspection");
      }
      assertInspectionDeadline();
      if (!registered) {
        return;
      }
      const current = probeScheduledTaskState(taskName, remainingTimeout());
      if (current.status === "unknown") {
        throw new ScheduledTaskInspectionError(current);
      }
      assertInspectionDeadline();
      if (
        current.status !== registered.status ||
        (registered.status === "found" &&
          (current.status !== "found" ||
            normalizeWindowsTaskIdentity(current.taskPath ?? "") !==
              normalizeWindowsTaskIdentity(registered.taskPath ?? "") ||
            !isDeepStrictEqual(current.actions, registered.actions)))
      ) {
        throw new Error("Scheduled Task registration changed during inspection");
      }
    };
    if (directExecutable) {
      assertStaticTaskPath(action.path);
      const argumentsText = action.arguments.trim();
      // Native executable arguments do not pass through CMD. Accept literal
      // whole arguments; expansion and ambiguous native quoting remain unknown.
      if (
        /[%\r\n\0]|\\"/.test(argumentsText) ||
        (argumentsText &&
          !/^(?:"[^"]+"|[^\s"]+)(?:[ \t]+(?:"[^"]+"|[^\s"]+))*$/.test(argumentsText))
      ) {
        throw new Error("Scheduled Task executable arguments cannot be inspected");
      }
      await assertRegistrationCurrent();
      const command = {
        programArguments: [action.path, ...splitArgsPreservingQuotes(argumentsText)],
        ...(action.workingDirectory ? { workingDirectory: action.workingDirectory } : {}),
      };
      assertCommandProfile(command);
      return command;
    }
    if (launchers?.length === 0) {
      await assertRegistrationCurrent();
      return null;
    }
    const scriptPath = launchers?.[0]?.scriptPath ?? resolveTaskScriptPath(env);
    const content = await readTaskFile(scriptPath, deadline);
    options?.onLauncherContent?.(content, scriptPath);
    let workingDirectory = "";
    let commandLine = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const lower = normalizeLowercaseStringOrEmpty(line);
      if (lower.startsWith("rem ")) {
        continue;
      }
      if (commandLine) {
        if (requireEffective) {
          throw new Error("Multiple Scheduled Task launcher commands");
        }
        break;
      }
      if (lower === "@echo off") {
        continue;
      }
      if (line === DIRECT_TASK_LAUNCHER_MARKER) {
        continue;
      }
      if (lower.startsWith("set ")) {
        const assignment = parseCmdSetAssignment(rawLine.trimStart().slice(4), requireEffective);
        if (!assignment && requireEffective) {
          throw new Error("Invalid Scheduled Task environment assignment");
        }
        if (assignment) {
          environment[assignment.key] = assignment.value;
        }
        continue;
      }
      // Managed literals are encoded; unresolved CMD expansion cannot prove argv or cwd.
      if (requireEffective && /[%!]/.test(line.replace(/%%|\^!/g, ""))) {
        throw new Error("Dynamic Scheduled Task launcher command");
      }
      if (lower.startsWith("cd /d ")) {
        const cdArguments = parseCmdScriptCommandLine(line);
        if (
          requireEffective &&
          (stripTrailingCmdRedirections(line) !== line || cdArguments.length !== 3)
        ) {
          throw new Error("Ambiguous Scheduled Task working directory");
        }
        workingDirectory = cdArguments[2] ?? "";
        continue;
      }
      // Generated stdin and operator-added output redirections are shell syntax,
      // not arguments of the process whose ownership lifecycle controls verify.
      const parsedCommand = stripTrailingCmdRedirections(line);
      if (parsedCommand === null && requireEffective) {
        throw new Error("Ambiguous Scheduled Task launcher command");
      }
      commandLine = parsedCommand ?? line;
    }
    if (!commandLine) {
      throw new Error("Missing Scheduled Task command");
    }
    const programArguments = parseCmdScriptCommandLine(commandLine).filter(
      (argument) => argument !== WINDOWS_TASK_SUPERVISOR_FLAG,
    );
    if (requireEffective && programArguments.length === 0) {
      throw new Error("Missing Scheduled Task command");
    }
    await assertRegistrationCurrent({ path: scriptPath, content });
    assertCommandProfile({ programArguments, environment });
    if (
      (registered || startupEntryPath !== undefined) &&
      ((registered &&
        environment.OPENCLAW_WINDOWS_TASK_NAME &&
        normalizeWindowsTaskIdentity(environment.OPENCLAW_WINDOWS_TASK_NAME) !==
          normalizeWindowsTaskIdentity(taskName)) ||
        (environment.OPENCLAW_TASK_SCRIPT &&
          path.win32.normalize(environment.OPENCLAW_TASK_SCRIPT).toLowerCase() !==
            path.win32.normalize(scriptPath).toLowerCase()))
    ) {
      throw new Error("Scheduled Task selector changed during inspection");
    }
    const managedDefinition: GatewayServiceCommandSnapshot = {
      // The task-only outer process owns the Job Object; diagnostics and lifecycle
      // controls must compare against its inner Gateway child, which omits this flag.
      programArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0
        ? {
            environment,
            environmentValueSources: Object.fromEntries(
              Object.keys(environment).map((key) => [key, "inline"]),
            ),
          }
        : {}),
    };
    return {
      ...managedDefinition,
      ...(action?.workingDirectory
        ? {
            workingDirectory: workingDirectory || action.workingDirectory,
            // Runtime intent binds the authored script; native cwd remains effective metadata.
            managedDefinition,
            managedOverrides:
              cmdLauncher &&
              path.win32.resolve(action.workingDirectory).toLowerCase() ===
                path.win32.resolve(path.win32.dirname(scriptPath)).toLowerCase()
                ? {}
                : { launcher: "working-directory" },
          }
        : {}),
      sourcePath: scriptPath,
      ...(startupEntryPath !== undefined
        ? { definitionPaths: [startupEntryPath, scriptPath] }
        : {}),
      ...(registered?.status === "missing" && launchers
        ? { startupEntryPaths: launchers.map(({ pathname }) => pathname) }
        : {}),
    };
  } catch (error) {
    if (error instanceof ServiceInspectionError) {
      throw error;
    }
    if (!requireEffective) {
      return null;
    }
    const remaining = deadline === undefined ? undefined : deadline - performance.now();
    if (
      target.kind === "scheduled-task" &&
      hasErrnoCode(error, "ENOENT") &&
      (remaining === undefined || remaining > 0) &&
      (await isScheduledTaskDefinitionAbsent({
        taskName: resolveTaskName(env),
        resolveDefinitionPaths: () => [
          resolveTaskScriptPath(env),
          ...resolveStartupEntryPaths(env),
        ],
        deadline,
      }).catch((inspectionError: unknown) => {
        if (inspectionError instanceof ServiceInspectionError) {
          throw inspectionError;
        }
        return false;
      })) &&
      (deadline === undefined || performance.now() < deadline)
    ) {
      return null;
    }
  }
  // Native failures can contain raw service credentials; expose only the closed diagnostic.
  throw new Error(
    startupEntryPath !== undefined
      ? "Startup service command could not be inspected."
      : "Effective Scheduled Task service command could not be inspected.",
  );
}

function createLauncherScriptLines(
  description: string | undefined,
  kind: "Task" | "Startup launcher" | "Hidden launcher",
): string[] {
  const hidden = kind === "Hidden launcher";
  const lines = hidden ? [] : ["@echo off"];
  const trimmedDescription = description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, `${kind} description`);
    lines.push(`${hidden ? "'" : "rem"} ${trimmedDescription}`);
  }
  return lines;
}

export function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const lines = createLauncherScriptLines(description, "Task");
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      // `set "NODE_OPTIONS="` clears inherited flags before the Node command runs.
      if (
        value === undefined ||
        (!value && key.toUpperCase() !== "NODE_OPTIONS") ||
        key.toUpperCase() === "PATH" ||
        // This preference chooses the launcher at install time. Persisting it
        // would overwrite the live WScript marker inherited by the supervisor.
        key.toUpperCase() === WINDOWS_TASK_LAUNCHER_ENV
      ) {
        continue;
      }
      lines.push(renderCmdSetAssignment(key, value));
    }
  }
  let commandArguments = programArguments;
  if (environment?.OPENCLAW_SERVICE_KIND === "gateway") {
    commandArguments = [...programArguments, WINDOWS_TASK_SUPERVISOR_FLAG];
    // Legacy VBS launchers supply their own outer owner; direct tasks own CMD.
    lines.push(DIRECT_TASK_LAUNCHER_MARKER);
  }
  lines.push(
    `${commandArguments.map((argument) => quoteCmdScriptArg(argument)).join(" ")} ${STDIN_NUL_REDIRECT}`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

export function buildStartupLauncherScript(params: {
  description?: string;
  scriptPath: string;
}): string {
  const lines = createLauncherScriptLines(params.description, "Startup launcher");
  lines.push(
    `start "" /min ${quoteCmdScriptArg(getWindowsCmdExePath())} /d /c ${quoteCmdScriptArg(params.scriptPath)}`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

function quoteVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildHiddenLauncherScript(params: {
  description?: string;
  scriptPath: string;
  taskSupervisor?: boolean;
}): string {
  const lines = createLauncherScriptLines(params.description, "Hidden launcher");
  lines.push('Set shell = CreateObject("WScript.Shell")');
  if (params.taskSupervisor) {
    lines.push(
      `shell.Environment("Process")("${WINDOWS_TASK_LAUNCHER_ENV}") = "${WINDOWS_TASK_LAUNCHER_ACTIVE}"`,
    );
  }
  lines.push(`WScript.Quit shell.Run(${quoteVbsString(`"${params.scriptPath}"`)}, 0, True)`);
  return `${lines.join("\r\n")}\r\n`;
}

export { encodeWindowsLauncherScript, resolveTaskScriptPath };
