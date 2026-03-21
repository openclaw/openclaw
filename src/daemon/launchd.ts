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
import {
  isCurrentProcessLaunchdServiceLabel,
  scheduleDetachedLaunchdRestartHandoff,
} from "./launchd-restart-handoff.js";
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
  GatewayServiceRestartResult,
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
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
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

const RESTART_PID_WAIT_TIMEOUT_MS = 10_000;
const RESTART_PID_WAIT_INTERVAL_MS = 200;

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll until the process exits or the timeout elapses.
 * Returns true if the process exited within the timeout, false if it is
 * still alive after the deadline.
 */
async function waitForPidExit(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 1) {
    return true;
  }
  const deadline = Date.now() + RESTART_PID_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH → process is gone (desired outcome).
      // EPERM → process still exists but we can't signal it; keep polling.
      if (code === "ESRCH") {
        return true;
      }
    }
    await sleepMs(RESTART_PID_WAIT_INTERVAL_MS);
  }
  return false;
}

/**
 * Return an opaque identity token for a PID (its start time as reported by
 * `ps`), or null if the process no longer exists.  Used to guard against
 * accidental SIGKILL of a recycled PID.
 */
async function getPidStartTime(pid: number): Promise<string | null> {
  try {
    const result = await execFileUtf8("ps", ["-p", String(pid), "-o", "lstart="]);
    const ts = result.stdout.trim();
    return ts.length > 0 ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the process is dead: wait for it to exit gracefully, then
 * SIGKILL if it is still running after the timeout.
 * Returns true if the process is confirmed gone, false if SIGKILL also
 * failed (e.g. permission denied or the PID was already recycled).
 *
 * @param preBootoutIdentity - Optional identity token (start time) captured
 *   *before* bootout/stop was requested.  Passing this avoids the race where
 *   the original process exits quickly, the PID is reused, and the identity
 *   snapshot inside this function would bind to the new, unrelated process.
 */
async function ensurePidGone(pid: number, preBootoutIdentity?: string | null): Promise<boolean> {
  // Use the caller-supplied identity if provided (captured before bootout);
  // otherwise fall back to capturing it now.  The caller-supplied value is
  // strongly preferred because capturing it after bootout can race with PID reuse.
  const identityBefore =
    preBootoutIdentity !== undefined ? preBootoutIdentity : await getPidStartTime(pid);

  const exited = await waitForPidExit(pid);
  if (exited) {
    return true;
  }

  // If we never captured a pre-bootout identity we cannot safely determine
  // whether the PID still belongs to the original process.  Skip SIGKILL to
  // avoid accidentally killing an unrelated process that reused the PID.
  if (identityBefore === null) {
    return false;
  }

  // Re-validate identity: if the start time changed the original process is
  // already gone and a new, unrelated process now owns this PID — do not kill it.
  const identityNow = await getPidStartTime(pid);
  if (identityNow !== null && identityBefore !== identityNow) {
    // Different process; the one we wanted is gone.
    return true;
  }
  if (identityNow === null) {
    // Process disappeared between the wait and our check — gone.
    return true;
  }

  // Process is still alive after SIGTERM timeout — send SIGKILL.
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    // ESRCH means it exited between our identity check and the kill — that is fine.
    // Any other error (e.g. EPERM) means the process is still alive and unkillable;
    // return false so callers know the port may not be free.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      return false;
    }
    return true;
  }

  // Give the OS a moment to reap the process after SIGKILL.
  const killDeadline = Date.now() + 3_000;
  while (Date.now() < killDeadline) {
    await sleepMs(100);
    try {
      process.kill(pid, 0);
    } catch (err) {
      // ESRCH → process is gone (desired outcome).
      // EPERM → process still exists but we can't signal it; keep polling.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
    }
  }
  return false;
}

export async function stopLaunchAgent({ stdout, env }: GatewayServiceControlArgs): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });

  // Capture the PID (and its identity) before bootout so we can wait for the
  // process to exit and guard against accidental SIGKILL of a recycled PID.
  const runtime = await execLaunchctl(["print", `${domain}/${label}`]);
  const currentPid =
    runtime.code === 0
      ? parseLaunchctlPrint(runtime.stdout || runtime.stderr || "").pid
      : undefined;
  // Capture identity (process start time) NOW — before bootout — so that if the
  // original process exits quickly and the PID is reused, ensurePidGone can
  // detect the substitution and avoid killing the wrong process.
  const pidIdentity = typeof currentPid === "number" ? await getPidStartTime(currentPid) : null;

  const res = await execLaunchctl(["bootout", `${domain}/${label}`]);
  if (res.code !== 0 && !isLaunchctlNotLoaded(res)) {
    throw new Error(`launchctl bootout failed: ${res.stderr || res.stdout}`.trim());
  }

  // Wait for the process to actually exit; SIGKILL as fallback.
  if (typeof currentPid === "number") {
    const gone = await ensurePidGone(currentPid, pidIdentity);
    if (!gone) {
      stdout.write(
        `Warning: PID ${currentPid} may still be running after SIGKILL; port may not be free yet.\n`,
      );
    }
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
  // launchd can persist "disabled" state even after bootout + plist removal; clear it before bootstrap.
  await execLaunchctl(["enable", `${domain}/${label}`]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
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
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: serviceEnv });
  const plistPath = resolveLaunchAgentPlistPath(serviceEnv);
  const serviceTarget = `${domain}/${label}`;

  // Restart requests issued from inside the managed gateway process tree need a
  // detached handoff. A direct `kickstart -k` would terminate the caller before
  // it can finish the restart command.
  if (isCurrentProcessLaunchdServiceLabel(label)) {
    const handoff = scheduleDetachedLaunchdRestartHandoff({
      env: serviceEnv,
      mode: "kickstart",
      waitForPid: process.pid,
    });
    if (!handoff.ok) {
      throw new Error(`launchd restart handoff failed: ${handoff.detail ?? "unknown error"}`);
    }
    try {
      stdout.write(`${formatLine("Scheduled LaunchAgent restart", serviceTarget)}\n`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
        throw err;
      }
    }
    return { outcome: "scheduled" };
  }

  // Capture PID and identity BEFORE kickstart so that, if `kickstart -k` does
  // not fully drain the old process, we can verify the old PID is gone before
  // the new instance races for the port (mirrors the stopLaunchAgent pattern).
  const printBefore = await execLaunchctl(["print", serviceTarget]);
  const prevPid =
    printBefore.code === 0
      ? parseLaunchctlPrint(printBefore.stdout || printBefore.stderr || "").pid
      : undefined;
  const prevPidIdentity = typeof prevPid === "number" ? await getPidStartTime(prevPid) : undefined;

  const start = await execLaunchctl(["kickstart", "-k", serviceTarget]);
  if (start.code === 0) {
    // Verify the previous process is actually gone; `kickstart -k` should
    // handle this, but warn if the PID is still alive after the restart so
    // the port-still-busy race is observable.
    if (typeof prevPid === "number") {
      const gone = await ensurePidGone(prevPid, prevPidIdentity);
      if (!gone) {
        stdout.write(
          `Warning: PID ${prevPid} may still be running after restart; port may not be free yet.\n`,
        );
      }
    }
    try {
      stdout.write(`${formatLine("Restarted LaunchAgent", serviceTarget)}\n`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
        throw err;
      }
    }
    return { outcome: "completed" };
  }

  if (!isLaunchctlNotLoaded(start)) {
    throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
  }

  // If the service was previously booted out, re-register the plist and retry.
  await execLaunchctl(["enable", serviceTarget]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
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

  const retry = await execLaunchctl(["kickstart", "-k", serviceTarget]);
  if (retry.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${retry.stderr || retry.stdout}`.trim());
  }
  try {
    stdout.write(`${formatLine("Restarted LaunchAgent", serviceTarget)}\n`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
      throw err;
    }
  }
  return { outcome: "completed" };
}
