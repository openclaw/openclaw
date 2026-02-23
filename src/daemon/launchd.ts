import fs from "node:fs/promises";
import path from "node:path";
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
    const pid = Number.parseInt(pidValue, 10);
    if (Number.isFinite(pid)) {
      info.pid = pid;
    }
  }
  const exitStatusValue = entries["last exit status"];
  if (exitStatusValue) {
    const status = Number.parseInt(exitStatusValue, 10);
    if (Number.isFinite(status)) {
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

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
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

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
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
  await fs.mkdir(logDir, { recursive: true });

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
  await fs.mkdir(path.dirname(plistPath), { recursive: true });

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
  await fs.writeFile(plistPath, plist, "utf8");

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
}: GatewayServiceControlArgs): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  if (res.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${res.stderr || res.stdout}`.trim());
  }
  try {
    stdout.write(`${formatLine("Restarted LaunchAgent", `${domain}/${label}`)}\n`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
      throw err;
    }
  }
}
