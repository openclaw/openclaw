import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";
import { parseCmdScriptCommandLine } from "../daemon/cmd-argv.js";
import { resolveLocalRunShutdownHardExitMs } from "../tui/local-run-shutdown.js";
import { sleep } from "../utils/sleep.js";
import { getCommandPositionalsWithRootOptions } from "./cli-root-options.js";
import { extractErrorCode } from "./errors.js";
import { acquireFileLock, type FileLockHandle } from "./file-lock.js";
import {
  formatOpenClawProcessTitleForRoots,
  parseOpenClawProcessTitle,
  resolveOpenClawInstallationId,
} from "./openclaw-installation-id.js";
import { getWindowsPowerShellExePath } from "./windows-install-roots.js";

export type LocalTuiProcess = {
  pid: number;
  command: string;
  ownership: "target" | "ambiguous" | "foreign-user" | "companion";
};

export type LocalTuiProcessDiscovery =
  | { ok: true; processes: LocalTuiProcess[] }
  | { ok: false; error: string };

type ProcessSignal = "SIGTERM" | "SIGKILL";
type ProcessController = { kill: (pid: number, signal: ProcessSignal | 0) => boolean };
type PsResult = { error?: Error; status: number | null; stdout?: string };
type CurrentTarget = "target" | "gone" | "unknown";
type LocalOpenClawProcessKind = "tui" | "update";
export type LocalProcessDiscoveryParams = {
  processKind?: "tui" | "update";
  targetRoot?: string;
  platform?: NodeJS.Platform;
  currentUid?: number;
  currentPid?: number;
  spawnSync?: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => PsResult;
};

const LOCAL_TUI_SUBCOMMANDS = new Set(["chat", "resume", "terminal", "tui"]);
const LEGACY_LOCAL_TUI_PROCESS_TITLES = new Set(
  [...LOCAL_TUI_SUBCOMMANDS].map((command) => `openclaw-${command}`),
);
const NODE_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--import",
  "--loader",
  "--max-old-space-size",
  "--require",
  "--stack-size",
  "-C",
  "-r",
]);
const LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS = 1_000;
const LOCAL_TUI_EXIT_POLL_MS = 100;
const WINDOWS_LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS = 5_000;
const LOCAL_TUI_UPDATE_ANNOUNCEMENT_TIMEOUT_MS = 5_000;
const LOCAL_PROCESS_ANNOUNCEMENT_MARKER = "openclaw-process-announcement";
const LOCAL_TUI_UPDATE_LOCK_OPTIONS = {
  stale: 30_000,
  retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 250 },
  staleRecovery: "remove-if-unchanged" as const,
};
const LOCAL_TUI_STARTUP_LOCK_OPTIONS = {
  ...LOCAL_TUI_UPDATE_LOCK_OPTIONS,
  retries: { ...LOCAL_TUI_UPDATE_LOCK_OPTIONS.retries, retries: 0 },
};

function resolveLocalTuiUpdateLockPath(targetRoot: string): string {
  // File sidecars cannot be both cross-account and safely recoverable in a sticky temp
  // directory. Keep this owner-scoped; process-title discovery coordinates other accounts.
  return path.join(
    resolveSecureTempRoot({ fallbackPrefix: "openclaw-local-tui-update" }),
    resolveOpenClawInstallationId(targetRoot),
  );
}

function tokenizeCommandLine(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

function normalizeExecutableName(value: string | undefined): string {
  return (
    (value ?? "")
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.exe$/iu, "") ?? ""
  );
}

function resolveOpenClawCommand(args: readonly string[]): string | null | undefined {
  const positionals = getCommandPositionalsWithRootOptions(["node", "openclaw", ...args], {
    commandPath: [],
    maxPositionals: 1,
  });
  return positionals === null ? null : positionals[0];
}

function isLocalTuiSubcommand(command: string | null | undefined, allowBare: boolean): boolean {
  return (
    (allowBare && command === undefined) ||
    (command !== null && command !== undefined && LOCAL_TUI_SUBCOMMANDS.has(command))
  );
}

function findNodeOpenClawEntrypoint(argv: readonly string[]): number | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) {
      continue;
    }
    if (normalizeExecutableName(argument) === "openclaw.mjs") {
      return index;
    }
    if (argument === "--") {
      return normalizeExecutableName(argv[index + 1]) === "openclaw.mjs" ? index + 1 : undefined;
    }
    if (NODE_OPTIONS_WITH_SEPARATE_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    // The respawn owner preserves valid single-token Node flags before argv[1].
    // A non-option before the entrypoint belongs to another Node program.
    if (!argument.startsWith("-")) {
      return undefined;
    }
  }
  return undefined;
}

function classifyLocalOpenClawCommand(
  command: string,
  platform: NodeJS.Platform,
  targetRoot: string | undefined,
  realpath: (value: string) => string,
  kind: LocalOpenClawProcessKind,
): LocalTuiProcess["ownership"] | "other" | undefined {
  const argv =
    platform === "win32" ? parseCmdScriptCommandLine(command) : tokenizeCommandLine(command);
  const processTitle = parseOpenClawProcessTitle(argv[0] ?? "");
  // Windows CIM preserves the marker child's launch command rather than its
  // process.title. Match only that node -e argument shape; POSIX exposes the title in argv[0].
  const announcedTitle =
    platform === "win32" &&
    normalizeExecutableName(argv[0]) === "node" &&
    argv[1] === "-e" &&
    argv.at(-3) === LOCAL_PROCESS_ANNOUNCEMENT_MARKER &&
    /^\d+$/u.test(argv.at(-2) ?? "")
      ? parseOpenClawProcessTitle(argv.at(-1) ?? "")
      : undefined;
  const announcedTui = announcedTitle?.name === "openclaw-tui" ? announcedTitle : undefined;
  const announcedUpdate = announcedTitle?.name === "openclaw-update" ? announcedTitle : undefined;
  const executable = processTitle?.name ?? normalizeExecutableName(argv[0]);
  const entryIndex = executable === "node" ? findNodeOpenClawEntrypoint(argv) : undefined;
  const isNodeLaunch = entryIndex !== undefined;
  const pathApi = platform === "win32" ? path.win32 : path;
  const directCommand = executable === "openclaw" ? resolveOpenClawCommand(argv.slice(1)) : null;
  const nodeCommand = isNodeLaunch ? resolveOpenClawCommand(argv.slice(entryIndex + 1)) : null;
  // A plain `openclaw` title can be any Commander action after pre-action. Bare
  // TUI launch is safe to infer only when argv retains a bindable entrypoint path.
  const directBareTui = pathApi.isAbsolute(argv[0] ?? "");
  const nodeBareTui = isNodeLaunch && pathApi.isAbsolute(argv[entryIndex] ?? "");
  const matches =
    kind === "tui"
      ? announcedTui !== undefined ||
        LEGACY_LOCAL_TUI_PROCESS_TITLES.has(executable) ||
        (executable === "openclaw" && isLocalTuiSubcommand(directCommand, directBareTui)) ||
        (isNodeLaunch && isLocalTuiSubcommand(nodeCommand, nodeBareTui))
      : processTitle?.name === "openclaw-update" || announcedUpdate !== undefined;
  if (!matches) {
    return undefined;
  }
  if (!targetRoot) {
    return "ambiguous";
  }
  const installationTitle =
    kind === "update" ? (announcedUpdate ?? processTitle) : (announcedTui ?? processTitle);
  if (installationTitle) {
    try {
      const matchesInstallation = installationTitle.installationIds.includes(
        resolveOpenClawInstallationId(targetRoot),
      );
      return matchesInstallation ? (announcedTui ? "companion" : "target") : "other";
    } catch {
      return "ambiguous";
    }
  }
  const entrypoint = isNodeLaunch ? argv[entryIndex] : argv[0];
  if (!entrypoint || !pathApi.isAbsolute(entrypoint)) {
    return "ambiguous";
  }
  try {
    const relative = pathApi.relative(realpath(targetRoot), realpath(entrypoint));
    return relative === "" ||
      (!relative.startsWith(`..${pathApi.sep}`) &&
        relative !== ".." &&
        !pathApi.isAbsolute(relative))
      ? "target"
      : "other";
  } catch {
    return "ambiguous";
  }
}

function parseLocalOpenClawProcessLine(
  line: string,
  currentUid: number,
  currentPid: number,
  platform: NodeJS.Platform,
  targetRoot: string | undefined,
  realpath: (value: string) => string,
  kind: LocalOpenClawProcessKind,
): LocalTuiProcess | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const pid = Number(match[2]);
  if (!Number.isFinite(pid) || pid <= 0 || pid === currentPid) {
    return null;
  }
  const command = match[3]?.trim() ?? "";
  const ownership = classifyLocalOpenClawCommand(command, platform, targetRoot, realpath, kind);
  if (!ownership || ownership === "other") {
    return null;
  }
  if (Number(match[1]) !== currentUid) {
    return ownership === "target"
      ? { pid, command, ownership: "foreign-user" }
      : { pid, command, ownership: "ambiguous" };
  }
  return { pid, command, ownership };
}

function discoverLocalOpenClawProcesses(
  params: LocalProcessDiscoveryParams,
  kind: LocalOpenClawProcessKind,
): LocalTuiProcessDiscovery {
  const platform = params.platform ?? process.platform;
  const realpath = fs.realpathSync.native;
  if (platform === "win32") {
    const result = (params.spawnSync ?? spawnSync)(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-Command",
        "$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match '(?i)openclaw' } | ForEach-Object { $ownerSid=(Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid; [pscustomobject]@{ProcessId=$_.ProcessId;CommandLine=$_.CommandLine;OwnerSid=$ownerSid;CurrentSid=$currentSid} } | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: WINDOWS_LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS,
      },
    );
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return { ok: false, error: "Windows process discovery failed." };
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      const processes = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const pidValue = Reflect.get(entry, "ProcessId");
        const commandValue = Reflect.get(entry, "CommandLine");
        const ownerSidValue = Reflect.get(entry, "OwnerSid");
        const currentSidValue = Reflect.get(entry, "CurrentSid");
        const pid = typeof pidValue === "number" ? pidValue : undefined;
        const command = typeof commandValue === "string" ? commandValue.trim() : undefined;
        const ownership = command
          ? classifyLocalOpenClawCommand(command, platform, params.targetRoot, realpath, kind)
          : undefined;
        if (
          !pid ||
          pid === (params.currentPid ?? process.pid) ||
          !command ||
          !ownership ||
          ownership === "other"
        ) {
          return [];
        }
        if (
          typeof ownerSidValue !== "string" ||
          typeof currentSidValue !== "string" ||
          ownerSidValue !== currentSidValue
        ) {
          return [
            {
              pid,
              command,
              ownership: ownership === "target" ? ("foreign-user" as const) : ownership,
            },
          ];
        }
        return [{ pid, command, ownership }];
      });
      return { ok: true, processes };
    } catch {
      return { ok: false, error: "Windows process discovery returned invalid JSON." };
    }
  }
  const currentUid = params.currentUid ?? process.getuid?.();
  if (currentUid === undefined) {
    return { ok: false, error: "The current user id is unavailable for process discovery." };
  }
  const ps = (params.spawnSync ?? spawnSync)("ps", ["-axo", "uid=,pid=,command="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS,
  });
  if (ps.error || ps.status !== 0 || typeof ps.stdout !== "string") {
    return { ok: false, error: "POSIX process discovery failed." };
  }
  const seen = new Set<number>();
  const processes: LocalTuiProcess[] = [];
  for (const line of ps.stdout.split(/\r?\n/)) {
    const proc = parseLocalOpenClawProcessLine(
      line,
      currentUid,
      params.currentPid ?? process.pid,
      platform,
      params.targetRoot,
      realpath,
      kind,
    );
    if (!proc || seen.has(proc.pid)) {
      continue;
    }
    seen.add(proc.pid);
    processes.push(proc);
  }
  return { ok: true, processes };
}

/** Lists local TUI clients, or updater announcements used by the startup handshake. */
export function discoverLocalTuiProcesses(
  params: LocalProcessDiscoveryParams = {},
): LocalTuiProcessDiscovery {
  return discoverLocalOpenClawProcesses(params, params.processKind ?? "tui");
}

function isProcessAlive(controller: ProcessController, pid: number): boolean {
  try {
    controller.kill(pid, 0);
    return true;
  } catch (error) {
    return extractErrorCode(error) !== "ESRCH";
  }
}

function readCurrentLocalTuiTarget(
  pid: number,
  targetRoot: string,
  discover: typeof discoverLocalTuiProcesses = discoverLocalTuiProcesses,
): CurrentTarget {
  const discovery = discover({ targetRoot });
  if (!discovery.ok) {
    return "unknown";
  }
  const current = discovery.processes.find((process) => process.pid === pid);
  return current ? (current.ownership === "target" ? "target" : "unknown") : "gone";
}

/** Terminates verified local TUI processes, rechecking ownership before each signal. */
export async function terminateLocalTuiProcesses(params: {
  processes: LocalTuiProcess[];
  targetRoot: string;
  controller?: ProcessController;
  graceMs?: number;
  killGraceMs?: number;
  readCurrentTarget?: (pid: number, targetRoot: string) => CurrentTarget;
  discover?: typeof discoverLocalTuiProcesses;
  assertCurrent?: () => void;
}): Promise<{ stopped: number[]; failed: number[] }> {
  const controller = params.controller ?? process;
  const graceMs = Math.max(0, params.graceMs ?? resolveLocalRunShutdownHardExitMs());
  const killGraceMs = Math.max(0, params.killGraceMs ?? 250);
  const inspect =
    params.readCurrentTarget ??
    ((pid: number, targetRoot: string) =>
      readCurrentLocalTuiTarget(pid, targetRoot, params.discover));
  const stopped: number[] = [];
  const failed: number[] = [];

  for (const proc of params.processes) {
    if (proc.ownership !== "target") {
      continue;
    }
    const current = inspect(proc.pid, params.targetRoot);
    if (current === "gone" || !isProcessAlive(controller, proc.pid)) {
      stopped.push(proc.pid);
      continue;
    }
    if (current === "unknown") {
      failed.push(proc.pid);
      continue;
    }
    params.assertCurrent?.();
    try {
      controller.kill(proc.pid, "SIGTERM");
    } catch (error) {
      if (extractErrorCode(error) === "ESRCH") {
        stopped.push(proc.pid);
      } else {
        failed.push(proc.pid);
      }
    }
  }
  if (graceMs > 0) {
    const deadline = Date.now() + graceMs;
    while (
      params.processes.some(
        (proc) =>
          proc.ownership === "target" &&
          !stopped.includes(proc.pid) &&
          !failed.includes(proc.pid) &&
          isProcessAlive(controller, proc.pid),
      )
    ) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(LOCAL_TUI_EXIT_POLL_MS, remainingMs));
    }
  }
  const escalated: number[] = [];
  for (const proc of params.processes) {
    if (proc.ownership !== "target" || stopped.includes(proc.pid) || failed.includes(proc.pid)) {
      continue;
    }
    if (!isProcessAlive(controller, proc.pid)) {
      stopped.push(proc.pid);
      continue;
    }
    const current = inspect(proc.pid, params.targetRoot);
    if (current === "gone") {
      stopped.push(proc.pid);
      continue;
    }
    if (current === "unknown") {
      failed.push(proc.pid);
      continue;
    }
    params.assertCurrent?.();
    try {
      controller.kill(proc.pid, "SIGKILL");
      escalated.push(proc.pid);
    } catch (error) {
      if (extractErrorCode(error) === "ESRCH") {
        stopped.push(proc.pid);
      } else {
        failed.push(proc.pid);
      }
    }
  }
  if (escalated.length > 0 && killGraceMs > 0) {
    await sleep(killGraceMs);
  }
  for (const pid of escalated) {
    (isProcessAlive(controller, pid) ? failed : stopped).push(pid);
  }
  return { stopped, failed };
}

function formatLocalTuiPidList(processes: readonly LocalTuiProcess[]): string {
  return processes.map((proc) => String(proc.pid)).join(", ");
}

export type LocalTuiUpdateGate = FileLockHandle & { stopped: number[]; warnings: string[] };

export type LocalTuiUpdateAnnouncement = {
  pid: number;
  release: () => Promise<void>;
};

const UPDATE_ANNOUNCEMENT_SCRIPT =
  "const parent=Number(process.argv[2]);process.title=process.argv[3];process.stdout.write('ready\\n');setInterval(()=>{try{process.kill(parent,0)}catch{process.exit(0)}},250)";

async function announceLocalOpenClawProcess(
  name: "openclaw-tui" | "openclaw-update",
  roots: readonly string[],
): Promise<LocalTuiUpdateAnnouncement> {
  const title = formatOpenClawProcessTitleForRoots(name, roots);
  const child = spawn(
    process.execPath,
    [
      "-e",
      UPDATE_ANNOUNCEMENT_SCRIPT,
      LOCAL_PROCESS_ANNOUNCEMENT_MARKER,
      String(process.pid),
      title,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out publishing the local TUI update announcement."));
    }, LOCAL_TUI_UPDATE_ANNOUNCEMENT_TIMEOUT_MS);
    const settle = (operation: () => void) => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      operation();
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(() =>
        reject(
          new Error(
            `Local TUI update announcement exited before readiness (${signal ?? code ?? "unknown"}).`,
          ),
        ),
      );
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.once("data", () => settle(resolve));
  }).catch((error: unknown) => {
    child.kill();
    throw error;
  });
  return {
    pid: child.pid!,
    release: async () => await stopUpdateAnnouncement(child),
  };
}

/** Publishes activation through a small runtime-independent child process. */
export async function announceLocalTuiUpdate(
  roots: readonly string[],
): Promise<LocalTuiUpdateAnnouncement> {
  return await announceLocalOpenClawProcess("openclaw-update", roots);
}

/** Makes an internal Windows TUI visible to updater process discovery. */
export async function announceLocalTuiClient(root: string): Promise<LocalTuiUpdateAnnouncement> {
  return await announceLocalOpenClawProcess("openclaw-tui", [root]);
}

async function stopUpdateAnnouncement(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  if (!child.kill()) {
    throw new Error(`Could not stop local TUI update announcement ${child.pid ?? "unknown"}.`);
  }
  await exited;
}

/** Quiesces clients at the shared update mutation boundary. */
export async function quiesceLocalTuiProcessesBeforeUpdate(
  targetRoot: string,
  overrides: {
    discover?: typeof discoverLocalTuiProcesses;
    discoverUpdates?: typeof discoverLocalTuiProcesses;
    terminate?: typeof terminateLocalTuiProcesses;
    acquireLock?: typeof acquireFileLock;
    assertCurrent?: () => void;
  } = {},
): Promise<LocalTuiUpdateGate> {
  // Keep startup and discovery in one interprocess order. The updater retains
  // this gate until mutation ends, so a newly launched TUI cannot enter stale code.
  const updateLock = await (overrides.acquireLock ?? acquireFileLock)(
    resolveLocalTuiUpdateLockPath(targetRoot),
    LOCAL_TUI_UPDATE_LOCK_OPTIONS,
  );
  try {
    overrides.assertCurrent?.();
    const updaterDiscovery = (overrides.discoverUpdates ?? discoverLocalTuiProcesses)({
      targetRoot,
      processKind: "update",
    });
    if (!updaterDiscovery.ok) {
      throw new Error(
        `Update refused: could not inspect concurrent OpenClaw updates before activation: ${updaterDiscovery.error} Retry after confirming that no other update is running.`,
      );
    }
    // The account-local lock serializes same-owner waiters. A foreign announcement
    // means that updater already owns or is seeking activation, so fail closed.
    const competingUpdater = updaterDiscovery.processes.find(
      (candidate) => candidate.ownership !== "target",
    );
    if (competingUpdater) {
      throw new Error(
        `Update refused: another OpenClaw update (${competingUpdater.pid}) is already active for this installation. Wait for it to finish, then retry.`,
      );
    }
    const discovery = (overrides.discover ?? discoverLocalTuiProcesses)({ targetRoot });
    if (!discovery.ok) {
      throw new Error(
        `Update refused: could not inspect local TUI clients before activation: ${discovery.error} Close any local TUI clients, then retry the update.`,
      );
    }
    const companionClients = discovery.processes.filter(
      (candidate) => candidate.ownership === "companion",
    );
    if (companionClients.length > 0) {
      throw new Error(
        `Update refused: Windows TUI clients (${formatLocalTuiPidList(companionClients)}) are using this installation and cannot be stopped safely from their launch command. Close them, then retry.`,
      );
    }
    const foreignUsers = discovery.processes.filter((proc) => proc.ownership === "foreign-user");
    if (foreignUsers.length > 0) {
      throw new Error(
        `Update refused: local TUI clients ${formatLocalTuiPidList(foreignUsers)} not owned by the current user are using this installation. Ask their owners to close them, then retry the update.`,
      );
    }
    const ambiguous = discovery.processes.filter((proc) => proc.ownership === "ambiguous");
    if (ambiguous.length > 0) {
      throw new Error(
        `Update refused: local TUI clients ${formatLocalTuiPidList(ambiguous)} could not be bound to an installation. Close them, then retry the update.`,
      );
    }
    const targets = discovery.processes.filter((proc) => proc.ownership === "target");
    const warnings: string[] = [];
    if (targets.length === 0) {
      return Object.assign(updateLock, { stopped: [], warnings });
    }
    const stopped = await (overrides.terminate ?? terminateLocalTuiProcesses)({
      processes: targets,
      targetRoot,
      assertCurrent: overrides.assertCurrent,
    });
    if (stopped.failed.length > 0) {
      throw new Error(
        `Update refused: local TUI clients ${stopped.failed.join(", ")} could not be stopped. Close them, then retry the update.`,
      );
    }
    return Object.assign(updateLock, { stopped: stopped.stopped, warnings });
  } catch (error) {
    try {
      await updateLock.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Local TUI update gate acquisition failed and its lock could not be released",
        { cause: releaseError },
      );
    }
    throw error;
  }
}

/** Waits for an in-flight update before a TUI enters its loaded runtime. */
export async function waitForLocalTuiUpdate(
  targetRoot: string,
  acquireLock: typeof acquireFileLock = acquireFileLock,
  discoverUpdates: (targetRoot: string) => LocalTuiProcessDiscovery = (root) =>
    discoverLocalTuiProcesses({ targetRoot: root, processKind: "update" }),
): Promise<{ waitedForUpdate: boolean }> {
  let waitedForUpdate = false;
  for (;;) {
    try {
      const lock = await acquireLock(
        resolveLocalTuiUpdateLockPath(targetRoot),
        LOCAL_TUI_STARTUP_LOCK_OPTIONS,
      );
      await lock.release();
      const updates = discoverUpdates(targetRoot);
      if (!updates.ok) {
        throw new Error(
          `Unable to inspect local OpenClaw updates before TUI startup: ${updates.error}`,
        );
      }
      if (updates.processes.length === 0) {
        return { waitedForUpdate };
      }
      waitedForUpdate = true;
      await sleep(100);
    } catch (error) {
      if (extractErrorCode(error) !== "file_lock_timeout") {
        throw error;
      }
      waitedForUpdate = true;
      await sleep(100);
    }
  }
}
