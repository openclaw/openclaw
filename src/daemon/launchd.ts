import fs from "node:fs/promises";
import path from "node:path";
import { parseStrictInteger, parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  resolveGatewayServiceDescription,
  resolveGatewayLaunchAgentLabel,
  resolveLegacyGatewayLaunchAgentLabels,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import {
  buildLaunchAgentPlist as buildLaunchAgentPlistImpl,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveGatewayStateDir, resolveHomeDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";

const LAUNCH_AGENT_DIR_MODE = 0o755;
const LAUNCH_AGENT_PLIST_MODE = 0o644;

function resolveLaunchAgentLabel(args?: { env?: Record<string, string | undefined> }): string {
  const envLabel = args?.env?.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (envLabel) {
    return envLabel;
  }
  return resolveGatewayLaunchAgentLabel(args?.env?.OPENCLAW_PROFILE);
}

function resolveLaunchAgentPlistPathForLabel(
  env: Record<string, string | undefined>,
  label: string,
): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function resolveLaunchAgentPlistPath(env: GatewayServiceEnv): string {
  const label = resolveLaunchAgentLabel({ env });
  return resolveLaunchAgentPlistPathForLabel(env, label);
}

export function resolveGatewayLogPaths(env: GatewayServiceEnv): {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const stateDir = resolveGatewayStateDir(env);
  const logDir = path.join(stateDir, "logs");
  const prefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
  return {
    logDir,
    stdoutPath: path.join(logDir, `${prefix}.log`),
    stderrPath: path.join(logDir, `${prefix}.err.log`),
  };
}

export async function readLaunchAgentProgramArguments(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  return readLaunchAgentProgramArgumentsFromFile(plistPath);
}

export function buildLaunchAgentPlist({
  label = GATEWAY_LAUNCH_AGENT_LABEL,
  comment,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label?: string;
  comment?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}): string {
  return buildLaunchAgentPlistImpl({
    label,
    comment,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
}

async function execLaunchctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const isWindows = process.platform === "win32";
  const file = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "launchctl";
  const fileArgs = isWindows ? ["/d", "/s", "/c", "launchctl", ...args] : args;
  return await execFileUtf8(file, fileArgs, isWindows ? { windowsHide: true } : {});
}

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

async function ensureSecureDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true, mode: LAUNCH_AGENT_DIR_MODE });
  try {
    const stat = await fs.stat(targetPath);
    const mode = stat.mode & 0o777;
    const tightenedMode = mode & ~0o022;
    if (tightenedMode !== mode) {
      await fs.chmod(targetPath, tightenedMode);
    }
  } catch {
    // Best effort: keep install working even if chmod/stat is unavailable.
  }
}

export type LaunchctlPrintInfo = {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
};

export function parseLaunchctlPrint(output: string): LaunchctlPrintInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: LaunchctlPrintInfo = {};
  const state = entries.state;
  if (state) {
    info.state = state;
  }
  const pidValue = entries.pid;
  if (pidValue) {
    const pid = parseStrictPositiveInteger(pidValue);
    if (pid !== undefined) {
      info.pid = pid;
    }
  }
  const exitStatusValue = entries["last exit status"];
  if (exitStatusValue) {
    const status = parseStrictInteger(exitStatusValue);
    if (status !== undefined) {
      info.lastExitStatus = status;
    }
  }
  const exitReason = entries["last exit reason"];
  if (exitReason) {
    info.lastExitReason = exitReason;
  }
  return info;
}

export async function isLaunchAgentLoaded(args: GatewayServiceEnvArgs): Promise<boolean> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: args.env });
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  return res.code === 0;
}

export async function isLaunchAgentListed(args: GatewayServiceEnvArgs): Promise<boolean> {
  const label = resolveLaunchAgentLabel({ env: args.env });
  const res = await execLaunchctl(["list"]);
  if (res.code !== 0) {
    return false;
  }
  return res.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === label);
}

export async function launchAgentPlistExists(env: GatewayServiceEnv): Promise<boolean> {
  try {
    const plistPath = resolveLaunchAgentPlistPath(env);
    await fs.access(plistPath);
    return true;
  } catch {
    return false;
  }
}

export async function readLaunchAgentRuntime(
  env: Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  if (res.code !== 0) {
    return {
      status: "unknown",
      detail: (res.stderr || res.stdout).trim() || undefined,
      missingUnit: true,
    };
  }
  const parsed = parseLaunchctlPrint(res.stdout || res.stderr || "");
  const plistExists = await launchAgentPlistExists(env);
  const state = parsed.state?.toLowerCase();
  const status = state === "running" || parsed.pid ? "running" : state ? "stopped" : "unknown";
  return {
    status,
    state: parsed.state,
    pid: parsed.pid,
    lastExitStatus: parsed.lastExitStatus,
    lastExitReason: parsed.lastExitReason,
    cachedLabel: !plistExists,
  };
}

export async function repairLaunchAgentBootstrap(args: {
  env?: Record<string, string | undefined>;
}): Promise<{ ok: boolean; detail?: string }> {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  // launchd can persist "disabled" state after bootout; clear it before bootstrap
  // (matches the same guard in installLaunchAgent and restartLaunchAgent).
  await execLaunchctl(["enable", `${domain}/${label}`]);
  const boot = await bootstrapWithRetry(domain, plistPath);
  if (boot.code !== 0) {
    return { ok: false, detail: (boot.stderr || boot.stdout).trim() || undefined };
  }
  const kick = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  if (kick.code !== 0) {
    return { ok: false, detail: (kick.stderr || kick.stdout).trim() || undefined };
  }
  return { ok: true };
}

export type LegacyLaunchAgent = {
  label: string;
  plistPath: string;
  loaded: boolean;
  exists: boolean;
};

export async function findLegacyLaunchAgents(env: GatewayServiceEnv): Promise<LegacyLaunchAgent[]> {
  const domain = resolveGuiDomain();
  const results: LegacyLaunchAgent[] = [];
  for (const label of resolveLegacyGatewayLaunchAgentLabels(env.OPENCLAW_PROFILE)) {
    const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
    const res = await execLaunchctl(["print", `${domain}/${label}`]);
    const loaded = res.code === 0;
    let exists = false;
    try {
      await fs.access(plistPath);
      exists = true;
    } catch {
      // ignore
    }
    if (loaded || exists) {
      results.push({ label, plistPath, loaded, exists });
    }
  }
  return results;
}

export async function uninstallLegacyLaunchAgents({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacyLaunchAgent[]> {
  const domain = resolveGuiDomain();
  const agents = await findLegacyLaunchAgents(env);
  if (agents.length === 0) {
    return agents;
  }

  const home = toPosixPath(resolveHomeDir(env));
  const trashDir = path.posix.join(home, ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  for (const agent of agents) {
    await execLaunchctl(["bootout", domain, agent.plistPath]);
    await execLaunchctl(["unload", agent.plistPath]);

    try {
      await fs.access(agent.plistPath);
    } catch {
      continue;
    }

    const dest = path.join(trashDir, `${agent.label}.plist`);
    try {
      await fs.rename(agent.plistPath, dest);
      stdout.write(`${formatLine("Moved legacy LaunchAgent to Trash", dest)}\n`);
    } catch {
      stdout.write(`Legacy LaunchAgent remains at ${agent.plistPath} (could not move)\n`);
    }
  }

  return agents;
}

export async function uninstallLaunchAgent({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);

  try {
    await fs.access(plistPath);
  } catch {
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = toPosixPath(resolveHomeDir(env));
  const trashDir = path.posix.join(home, ".Trash");
  const dest = path.join(trashDir, `${label}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
  } catch {
    stdout.write(`LaunchAgent remains at ${plistPath} (could not move)\n`);
  }
}

function isLaunchctlNotLoaded(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = (res.stderr || res.stdout).toLowerCase();
  return (
    detail.includes("no such process") ||
    detail.includes("could not find service") ||
    detail.includes("not found")
  );
}

function isUnsupportedGuiDomain(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("domain does not support specified action") ||
    normalized.includes("bootstrap failed: 125")
  );
}

/**
 * Detect errno 5 (EIO): launchd rejects bootstrap while the old process is still
 * alive in the process table, even after bootout succeeds. This happens when
 * Node's graceful shutdown (draining connections, flushing queues) outlasts the
 * caller's wait window. Retrying after a brief delay resolves it once the kernel
 * reaps the process.
 */
function isBootstrapProcessStillAlive(detail: string): boolean {
  const normalized = detail.toLowerCase();
  // "Bootstrap failed: 5" is launchctl's errno 5 (EIO).
  // Guard against confusing it with errno 125 (unsupported GUI domain).
  return (
    normalized.includes("bootstrap failed: 5:") ||
    (normalized.includes("input/output error") && !normalized.includes("bootstrap failed: 125"))
  );
}

// How long to wait for Node's graceful SIGTERM shutdown before escalating.
const RESTART_GRACEFUL_WAIT_MS = 15_000;
// How long to wait for SIGKILL to take effect after the graceful window expires.
const RESTART_SIGKILL_WAIT_MS = 5_000;
const RESTART_WAIT_INTERVAL_MS = 200;
// Retry bootstrap up to this many times when EIO indicates the old process is
// still alive (e.g. kernel hasn't reaped it yet despite SIGKILL).
// Exponential backoff delays: 500, 1000, 2000, 4000 ms (total ≤ 7.5 s).
const BOOTSTRAP_EIO_RETRY_COUNT = 4;
const BOOTSTRAP_EIO_RETRY_BASE_MS = 500;

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Returns true while the process is alive and reachable by the current user.
 * ESRCH means the process is gone. EPERM means the process exists but is owned
 * by a different user — treat as alive so we don't stop waiting prematurely.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wait for a process to exit, escalating to SIGKILL if it does not honour SIGTERM
 * within the graceful window.
 *
 * Node.js gateways can take >10 s to shut down gracefully (draining in-flight
 * agent replies, flushing delivery queues, closing WebSocket connections). The old
 * 10 s hard-stop caused `launchctl bootstrap` to be called while the process was
 * still alive, producing `Bootstrap failed: 5: Input/output error` (EIO) and
 * leaving the service permanently unregistered.
 *
 * Escalation schedule:
 *   0 – 15 s  poll every 200 ms for voluntary exit (SIGTERM already sent by bootout)
 *   15 s      send SIGKILL
 *   15 – 20 s poll every 200 ms for kernel reap after SIGKILL
 *   20 s+     give up waiting; bootstrap retry handles any residual EIO
 */
export async function waitForPidExitWithEscalation(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 1) {
    return;
  }

  // Phase 1: wait for graceful SIGTERM-induced shutdown.
  const gracefulDeadline = Date.now() + RESTART_GRACEFUL_WAIT_MS;
  while (Date.now() < gracefulDeadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleepMs(RESTART_WAIT_INTERVAL_MS);
  }

  // Phase 2: process survived the graceful window — escalate to SIGKILL.
  // One final check before sending SIGKILL to guard against PID reuse: if the
  // process exited during the last polling sleep we must not kill a recycled PID.
  if (!isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have exited between the liveness check and the kill call.
  }

  const killDeadline = Date.now() + RESTART_SIGKILL_WAIT_MS;
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleepMs(RESTART_WAIT_INTERVAL_MS);
  }
  // Process survived SIGKILL (zombie or kernel-protected task). Proceed to
  // bootstrap; the EIO retry loop below handles any residual launchd conflict.
}

/**
 * Execute `launchctl bootstrap` with automatic retry on EIO (errno 5).
 *
 * launchd returns EIO when the old process is still present in the kernel
 * process table even though bootout succeeded and the process is no longer
 * scheduled. This race is common on macOS 15+ where kernel reaping is
 * asynchronous relative to launchd's domain book-keeping. Retrying with
 * exponential backoff (500 ms × 2^(attempt−1)) lets the kernel catch up without
 * requiring callers to handle the error.
 *
 * Non-retriable errors (unsupported GUI domain, permission denied, etc.) are
 * returned immediately on the first attempt.
 */
export async function bootstrapWithRetry(
  domain: string,
  plistPath: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let result = await execLaunchctl(["bootstrap", domain, plistPath]);
  for (let attempt = 1; attempt <= BOOTSTRAP_EIO_RETRY_COUNT; attempt++) {
    if (result.code === 0) {
      return result;
    }
    const detail = (result.stderr || result.stdout).trim();
    if (!isBootstrapProcessStillAlive(detail)) {
      // Not an EIO/process-alive error — don't retry.
      return result;
    }
    await sleepMs(BOOTSTRAP_EIO_RETRY_BASE_MS * 2 ** (attempt - 1));
    result = await execLaunchctl(["bootstrap", domain, plistPath]);
  }
  return result;
}

export async function stopLaunchAgent({ stdout, env }: GatewayServiceControlArgs): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["bootout", `${domain}/${label}`]);
  if (res.code !== 0 && !isLaunchctlNotLoaded(res)) {
    throw new Error(`launchctl bootout failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Stopped LaunchAgent", `${domain}/${label}`)}\n`);
}

export async function installLaunchAgent({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: GatewayServiceInstallArgs): Promise<{ plistPath: string }> {
  const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
  await ensureSecureDirectory(logDir);

  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  for (const legacyLabel of resolveLegacyGatewayLaunchAgentLabels(env.OPENCLAW_PROFILE)) {
    const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
    await execLaunchctl(["bootout", domain, legacyPlistPath]);
    await execLaunchctl(["unload", legacyPlistPath]);
    try {
      await fs.unlink(legacyPlistPath);
    } catch {
      // ignore
    }
  }

  const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
  const home = toPosixPath(resolveHomeDir(env));
  const libraryDir = path.posix.join(home, "Library");
  await ensureSecureDirectory(home);
  await ensureSecureDirectory(libraryDir);
  await ensureSecureDirectory(path.dirname(plistPath));

  // Read the current running PID before writing the new plist so we can wait
  // for it to exit after bootout (same pattern as restartLaunchAgent).
  const runtimeBefore = await execLaunchctl(["print", `${domain}/${label}`]);
  const previousPid =
    runtimeBefore.code === 0
      ? parseLaunchctlPrint(runtimeBefore.stdout || runtimeBefore.stderr || "").pid
      : undefined;

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
  await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: LAUNCH_AGENT_PLIST_MODE });
  await fs.chmod(plistPath, LAUNCH_AGENT_PLIST_MODE).catch(() => undefined);

  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);
  if (typeof previousPid === "number") {
    await waitForPidExitWithEscalation(previousPid);
  }
  // launchd can persist "disabled" state even after bootout + plist removal; clear it before bootstrap.
  await execLaunchctl(["enable", `${domain}/${label}`]);
  const boot = await bootstrapWithRetry(domain, plistPath);
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim();
    if (isUnsupportedGuiDomain(detail)) {
      throw new Error(
        [
          `launchctl bootstrap failed: ${detail}`,
          `LaunchAgent install requires a logged-in macOS GUI session for this user (${domain}).`,
          "This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
          "Fix: sign in to the macOS desktop as the target user and rerun `openclaw gateway install --force`.",
          "Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway",
        ].join("\n"),
      );
    }
    throw new Error(`launchctl bootstrap failed: ${detail}`);
  }
  await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    stdout,
    [
      { label: "Installed LaunchAgent", value: plistPath },
      { label: "Logs", value: stdoutPath },
    ],
    { leadingBlankLine: true },
  );
  return { plistPath };
}

export async function restartLaunchAgent({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: serviceEnv });
  const plistPath = resolveLaunchAgentPlistPath(serviceEnv);

  const runtime = await execLaunchctl(["print", `${domain}/${label}`]);
  const previousPid =
    runtime.code === 0
      ? parseLaunchctlPrint(runtime.stdout || runtime.stderr || "").pid
      : undefined;

  const stop = await execLaunchctl(["bootout", `${domain}/${label}`]);
  if (stop.code !== 0 && !isLaunchctlNotLoaded(stop)) {
    throw new Error(`launchctl bootout failed: ${stop.stderr || stop.stdout}`.trim());
  }
  if (typeof previousPid === "number") {
    await waitForPidExitWithEscalation(previousPid);
  }

  // launchd can persist "disabled" state after bootout; clear it before bootstrap
  // (matches the same guard in installLaunchAgent).
  await execLaunchctl(["enable", `${domain}/${label}`]);
  const boot = await bootstrapWithRetry(domain, plistPath);
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim();
    if (isUnsupportedGuiDomain(detail)) {
      throw new Error(
        [
          `launchctl bootstrap failed: ${detail}`,
          `LaunchAgent restart requires a logged-in macOS GUI session for this user (${domain}).`,
          "This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
          "Fix: sign in to the macOS desktop as the target user and rerun `openclaw gateway restart`.",
          "Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway",
        ].join("\n"),
      );
    }
    throw new Error(`launchctl bootstrap failed: ${detail}`);
  }

  const start = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  if (start.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
  }
  try {
    stdout.write(`${formatLine("Restarted LaunchAgent", `${domain}/${label}`)}\n`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
      throw err;
    }
  }
}
