import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeProfileName } from "../cli/profile-utils.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseCmdScriptCommandLine, quoteCmdScriptArg } from "./cmd-argv.js";
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
import { publishServiceFile } from "./service-stage.js";
import type {
  GatewayServiceCommandConfig,
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

function stripTrailingCmdRedirections(commandLine: string): string | null {
  const tokens: { start: number; end: number; redirect?: string }[] = [];
  // Validate the entire command before removing anything. A compound command or
  // uncertain cmd/argv quote boundary must never become exact process-ownership proof.
  for (let index = 0; index < commandLine.length;) {
    if (/[ \t]/.test(commandLine.charAt(index))) {
      index++;
      continue;
    }
    let start = index;
    const operator = commandLine[index];
    if (operator === ">" || operator === "<") {
      const previous = tokens.at(-1);
      if (previous && !previous.redirect && previous.end === index) {
        const word = commandLine.slice(previous.start, previous.end);
        if (/\d$/.test(word)) {
          // A digit attached to an argument can instead be cmd's handle number.
          // Do not guess which bytes of that argument belong to the process.
          if (!/^\d$/.test(word)) {
            return null;
          }
          start = previous.start;
          tokens.pop();
        }
      }
      index++;
      let redirect: "<" | ">" | ">>" | ">&" = operator;
      if (operator === ">" && commandLine[index] === ">") {
        redirect = ">>";
        index++;
      }
      if (redirect === ">" && commandLine[index] === "&") {
        if (!/[0-9]/.test(commandLine[index + 1] ?? "")) {
          return null;
        }
        redirect = ">&";
        index += 2;
      }
      tokens.push({ start, end: index, redirect });
      continue;
    }
    let quoted = false;
    while (index < commandLine.length) {
      const char = commandLine.charAt(index);
      if (
        char === "\r" ||
        char === "\n" ||
        (char === "\\" && commandLine[index + 1] === '"') ||
        (char === "^" && (!quoted || commandLine[index + 1] === '"'))
      ) {
        return null;
      }
      if (char === '"') {
        quoted = !quoted;
      } else if (!quoted) {
        if ("&|()".includes(char)) {
          return null;
        }
        if (/[ \t<>]/.test(char)) {
          break;
        }
      }
      index++;
    }
    if (quoted) {
      return null;
    }
    tokens.push({ start, end: index });
  }

  const firstRedirect = tokens.findIndex((token) => token.redirect !== undefined);
  const firstToken = tokens[firstRedirect];
  if (!firstToken) {
    return commandLine;
  }
  for (let index = firstRedirect; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token?.redirect) {
      return null;
    }
    if (token.redirect === ">&") {
      continue;
    }
    const target = tokens[++index];
    if (!target || target.redirect) {
      return null;
    }
    const value = commandLine.slice(target.start, target.end);
    // Unquoted expansions can introduce filename delimiters and leave extra argv.
    if (
      (value.includes('"') && !/^"[^"]+"$/.test(value)) ||
      (!value.includes('"') && /[,;=%!]/.test(value)) ||
      (token.redirect === "<" && !/^(?:NUL|"NUL")$/i.test(value))
    ) {
      return null;
    }
  }
  // Redirection alone has no executable for the service reader to inspect.
  return commandLine.slice(0, firstToken.start);
}

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

export function resolveStartupEntryPath(env: GatewayServiceEnv, extension?: "cmd" | "vbs"): string {
  const taskName = resolveTaskName(env);
  const entryExtension = extension ?? (shouldUseHiddenWindowsTaskLauncher(env) ? "vbs" : "cmd");
  return path.join(
    resolveWindowsStartupDir(env),
    `${sanitizeWindowsFilename(taskName)}.${entryExtension}`,
  );
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

// Escape XML structure; launcher inputs already reject CR/LF in `assertNoCmdLineBreak`.
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// XML is required to disable both battery-stop defaults (#59299); the remaining
// fields mirror the former ONLOGON, least-privilege, single-instance CLI task.
export function buildScheduledTaskXml(params: {
  taskDescription: string;
  taskUser: string | null;
  launchPath: string;
}): string {
  const description = escapeXmlText(params.taskDescription);
  const command = escapeXmlText(params.launchPath);
  const principalLogon = params.taskUser
    ? `\n      <UserId>${escapeXmlText(params.taskUser)}</UserId>\n      <LogonType>InteractiveToken</LogonType>`
    : "\n      <GroupId>S-1-5-32-545</GroupId>";
  const triggerUser = params.taskUser
    ? `\n      <UserId>${escapeXmlText(params.taskUser)}</UserId>`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${description}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${triggerUser}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalLogon}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
    </Exec>
  </Actions>
</Task>`;
}

export async function writeTaskXmlTempFile(xml: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-xml-"));
  const xmlPath = path.join(tmpDir, "task.xml");
  // Task Scheduler `/XML` expects UTF-16 LE with a BOM on every locale.
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(xml, "utf16le");
  await publishServiceFile({
    filePath: xmlPath,
    contents: Buffer.concat([bom, body]),
    mode: 0o600,
  });
  return xmlPath;
}

export function shouldUseHiddenWindowsTaskLauncher(env: GatewayServiceEnv): boolean {
  const value = normalizeLowercaseStringOrEmpty(env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER);
  return value === "1" || value === "true" || value === "yes";
}

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
  onLauncherContent?: (content: string) => void,
  startup = false,
  deadline?: number,
): Promise<{ scriptPath: string; content?: string }> {
  assertTaskInspectionDeadline(deadline);
  assertStaticTaskPath(launcherPath);
  if (/\.cmd$/i.test(launcherPath) && !startup) {
    return { scriptPath: launcherPath };
  }
  if (!/\.(?:vbs|cmd)$/i.test(launcherPath)) {
    throw new Error("Unsupported Scheduled Task action");
  }
  const content = await readTaskFile(launcherPath, deadline);
  onLauncherContent?.(content);
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
  onLauncherContent?: (content: string) => void,
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
    onLauncherContent?: (content: string) => void;
    /** Inventory reads a Task's profile without admitting it as the caller's selected service. */
    profileScope?: "registered";
    /** Shared monotonic deadline for aggregate Windows inventory. */
    deadline?: number;
  },
): Promise<GatewayServiceCommandConfig | null> {
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
    const registered = options?.requireLoaded
      ? probeScheduledTaskState(taskName, remainingTimeout())
      : undefined;
    if (registered?.status === "unknown") {
      throw new ScheduledTaskInspectionError(registered);
    }
    assertInspectionDeadline();
    const assertCommandProfile = (command: GatewayServiceCommandConfig) => {
      if (!registered) {
        return;
      }
      const profile = resolveWindowsServiceCommandProfile(command);
      if (
        profile.kind === "unavailable" ||
        (options?.profileScope !== "registered" &&
          profile.profile !==
            (normalizeProfileName(resolveEnvironmentValue(env, "OPENCLAW_PROFILE", "win32")) ??
              "default"))
      ) {
        throw new Error("Scheduled Task selector changed during inspection");
      }
    };
    const action = registered?.status === "found" ? registered.actions?.[0] : undefined;
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
    const directExecutable = action && /\.exe$/i.test(action.path);
    if (action && !directExecutable && action.arguments.trim()) {
      throw new Error("Scheduled Task launcher arguments cannot be inspected");
    }
    const launchers =
      registered && !directExecutable
        ? await readTaskLaunchers(env, action?.path, options?.onLauncherContent, deadline)
        : undefined;
    const assertRegistrationCurrent = async (source?: { path: string; content: string }) => {
      if (!registered) {
        return;
      }
      if (
        (launchers &&
          !isDeepStrictEqual(
            await readTaskLaunchers(env, action?.path, undefined, deadline),
            launchers,
          )) ||
        (source && (await readTaskFile(source.path, deadline)) !== source.content)
      ) {
        throw new Error("Task launcher changed during inspection");
      }
      assertInspectionDeadline();
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
    options?.onLauncherContent?.(content);
    let workingDirectory = action?.workingDirectory ?? "";
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
      if (lower.startsWith("set ")) {
        const assignment = parseCmdSetAssignment(rawLine.trimStart().slice(4), requireEffective);
        if (!assignment && requireEffective) {
          throw new Error("Invalid Scheduled Task environment assignment");
        }
        if (assignment) {
          // Generated cmd launchers inline service env before the final command.
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
      registered &&
      ((environment.OPENCLAW_WINDOWS_TASK_NAME &&
        normalizeWindowsTaskIdentity(environment.OPENCLAW_WINDOWS_TASK_NAME) !==
          normalizeWindowsTaskIdentity(taskName)) ||
        (environment.OPENCLAW_TASK_SCRIPT &&
          path.win32.normalize(environment.OPENCLAW_TASK_SCRIPT).toLowerCase() !==
            path.win32.normalize(scriptPath).toLowerCase()))
    ) {
      throw new Error("Scheduled Task selector changed during inspection");
    }
    return {
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
      sourcePath: scriptPath,
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
  throw new Error("Effective Scheduled Task service command could not be inspected.");
}

export function buildTaskScript({
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
  // Redirect stdin from NUL: a Scheduled Task console (even hidden via the
  // VBS launcher) still hands the gateway real console handles, so
  // `process.stdin.isTTY` reports true and interactive permission prompts
  // block forever on a console no one can see (#112173). With stdin at NUL
  // the gateway and its workers correctly take non-interactive paths.
  const commandArguments =
    environment?.OPENCLAW_SERVICE_KIND === "gateway"
      ? [...programArguments, WINDOWS_TASK_SUPERVISOR_FLAG]
      : programArguments;
  lines.push(
    `${commandArguments.map((argument) => quoteCmdScriptArg(argument)).join(" ")} ${STDIN_NUL_REDIRECT}`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

function renderStartupLaunchCommand(scriptPath: string): string {
  const cmdExePath = quoteCmdScriptArg(getWindowsCmdExePath());
  return `start "" /min ${cmdExePath} /d /c ${quoteCmdScriptArg(scriptPath)}`;
}

export function buildStartupLauncherScript(params: {
  description?: string;
  scriptPath: string;
}): string {
  const lines = ["@echo off"];
  const trimmedDescription = params.description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Startup launcher description");
    lines.push(`rem ${trimmedDescription}`);
  }
  lines.push(renderStartupLaunchCommand(params.scriptPath));
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
  const lines = [];
  const trimmedDescription = params.description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Hidden launcher description");
    lines.push(`' ${trimmedDescription}`);
  }
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
