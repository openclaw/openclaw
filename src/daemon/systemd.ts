import fs from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveHomeDir } from "./paths.js";
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
import {
  enableSystemdUserLinger,
  readSystemdUserLingerStatus,
  type SystemdUserLingerStatus,
} from "./systemd-linger.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignment,
  parseSystemdExecStart,
} from "./systemd-unit.js";

function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}

function resolveSystemdSystemUnitPathForName(name: string): string {
  return `/etc/systemd/system/${name}.service`;
}

function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}

function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

function resolveSystemdSystemUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdSystemUnitPathForName(resolveSystemdServiceName(env));
}

export function resolveSystemdUserUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPath(env);
}

export { enableSystemdUserLinger, readSystemdUserLingerStatus };
export type { SystemdUserLingerStatus };

// Unit file parsing/rendering: see systemd-unit.ts

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  // Try user service first, then system service
  const userUnitPath = resolveSystemdUnitPath(env);
  const systemUnitPath = resolveSystemdSystemUnitPath(env);

  for (const unitPath of [userUnitPath, systemUnitPath]) {
    try {
      const content = await fs.readFile(unitPath, "utf8");
      let execStart = "";
      let workingDirectory = "";
      const environment: Record<string, string> = {};
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
          continue;
        }
        if (line.startsWith("ExecStart=")) {
          execStart = line.slice("ExecStart=".length).trim();
        } else if (line.startsWith("WorkingDirectory=")) {
          workingDirectory = line.slice("WorkingDirectory=".length).trim();
        } else if (line.startsWith("Environment=")) {
          const raw = line.slice("Environment=".length).trim();
          const parsed = parseSystemdEnvAssignment(raw);
          if (parsed) {
            environment[parsed.key] = parsed.value;
          }
        }
      }
      if (!execStart) {
        continue;
      }
      const programArguments = parseSystemdExecStart(execStart);
      return {
        programArguments,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
        sourcePath: unitPath,
      };
    } catch {
      // Continue to next path
    }
  }
  return null;
}

export type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
};

export function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) {
    info.activeState = activeState;
  }
  const subState = entries.substate;
  if (subState) {
    info.subState = subState;
  }
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = Number.parseInt(mainPidValue, 10);
    if (Number.isFinite(pid) && pid > 0) {
      info.mainPid = pid;
    }
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = Number.parseInt(execMainStatusValue, 10);
    if (Number.isFinite(status)) {
      info.execMainStatus = status;
    }
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) {
    info.execMainCode = execMainCode;
  }
  return info;
}

async function execSystemctl(
  args: string[],
  options?: { useSudo?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const cmd = options?.useSudo ? "sudo" : "systemctl";
    const cmdArgs = options?.useSudo ? ["-n", "systemctl", ...args] : args;
    return await execFileUtf8(cmd, cmdArgs);
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown; code?: unknown; message?: unknown };
    let stderr =
      typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "";

    if (options?.useSudo && stderr.includes("password is required")) {
      stderr += "\nHint: Passwordless sudo is required for system service management.";
    }

    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr,
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function isSystemdUserServiceAvailable(): Promise<boolean> {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) {
    return true;
  }
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (!detail) {
    return false;
  }
  if (detail.includes("not found")) {
    return false;
  }
  if (detail.includes("failed to connect")) {
    return false;
  }
  if (detail.includes("not been booted")) {
    return false;
  }
  if (detail.includes("no such file or directory")) {
    return false;
  }
  if (detail.includes("not supported")) {
    return false;
  }
  return false;
}

export async function isSystemdSystemServiceAvailable(): Promise<boolean> {
  // Check if we can run systemctl (may require sudo)
  const res = await execSystemctl(["status"], { useSudo: true });
  // If it doesn't error with "command not found", systemd is available
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (detail.includes("not found")) {
    return false;
  }
  if (detail.includes("command not found")) {
    return false;
  }
  return true;
}

async function assertSystemdAvailable() {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) {
    return;
  }
  const detail = res.stderr || res.stdout;
  if (detail.toLowerCase().includes("not found")) {
    throw new Error("systemctl not available; systemd user services are required on Linux.");
  }
  throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
}

export async function installSystemdService({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: GatewayServiceInstallArgs): Promise<{ unitPath: string }> {
  await assertSystemdAvailable();

  const unitPath = resolveSystemdUnitPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const unit = buildSystemdUnit({
    description: serviceDescription,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(unitPath, unit, "utf8");

  const serviceName = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
  const unitName = `${serviceName}.service`;
  const reload = await execSystemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
  }

  const enable = await execSystemctl(["--user", "enable", unitName]);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
  }

  const restart = await execSystemctl(["--user", "restart", unitName]);
  if (restart.code !== 0) {
    throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
  }

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    stdout,
    [
      {
        label: "Installed systemd service",
        value: unitPath,
      },
    ],
    { leadingBlankLine: true },
  );
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSystemdAvailable();
  const serviceName = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
  const unitName = `${serviceName}.service`;
  await execSystemctl(["--user", "disable", "--now", unitName]);

  const unitPath = resolveSystemdUnitPath(env);
  try {
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

export async function stopSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  const serviceName = resolveSystemdServiceName(env ?? {});
  const unitName = `${serviceName}.service`;

  // Try user service first
  const userRes = await execSystemctl(["--user", "stop", unitName]);
  if (userRes.code === 0) {
    stdout.write(`${formatLine("Stopped systemd user service", unitName)}\n`);
    return;
  }

  // Try system service
  const systemRes = await execSystemctl(["stop", unitName], { useSudo: true });
  if (systemRes.code === 0) {
    stdout.write(`${formatLine("Stopped systemd system service", unitName)}\n`);
    return;
  }

  throw new Error(`systemctl stop failed: ${systemRes.stderr || systemRes.stdout}`.trim());
}

export async function restartSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  const serviceName = resolveSystemdServiceName(env ?? {});
  const unitName = `${serviceName}.service`;

  // Try user service first
  const userRes = await execSystemctl(["--user", "restart", unitName]);
  if (userRes.code === 0) {
    stdout.write(`${formatLine("Restarted systemd user service", unitName)}\n`);
    return;
  }

  // Try system service
  const systemRes = await execSystemctl(["restart", unitName], { useSudo: true });
  if (systemRes.code === 0) {
    stdout.write(`${formatLine("Restarted systemd system service", unitName)}\n`);
    return;
  }

  throw new Error(`systemctl restart failed: ${systemRes.stderr || systemRes.stdout}`.trim());
}

export async function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const serviceName = resolveSystemdServiceName(args.env ?? {});
  const unitName = `${serviceName}.service`;

  // Check user service
  const userRes = await execSystemctl(["--user", "is-enabled", unitName]);
  if (userRes.code === 0) {
    return true;
  }

  // Check system service
  const systemRes = await execSystemctl(["is-enabled", unitName], { useSudo: true });
  return systemRes.code === 0;
}

export async function readSystemdServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;

  // Try user service first
  const userRes = await execSystemctl([
    "--user",
    "show",
    unitName,
    "--no-page",
    "--property",
    "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
  ]);

  if (userRes.code === 0) {
    const parsed = parseSystemdShow(userRes.stdout || "");
    const activeState = parsed.activeState?.toLowerCase();
    const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
    return {
      status,
      state: parsed.activeState,
      subState: parsed.subState,
      pid: parsed.mainPid,
      lastExitStatus: parsed.execMainStatus,
      lastExitReason: parsed.execMainCode,
    };
  }

  // Try system service
  const systemRes = await execSystemctl(
    [
      "show",
      unitName,
      "--no-page",
      "--property",
      "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
    ],
    { useSudo: true },
  );

  if (systemRes.code === 0) {
    const parsed = parseSystemdShow(systemRes.stdout || "");
    const activeState = parsed.activeState?.toLowerCase();
    const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
    return {
      status,
      state: parsed.activeState,
      subState: parsed.subState,
      pid: parsed.mainPid,
      lastExitStatus: parsed.execMainStatus,
      lastExitReason: parsed.execMainCode,
      isSystemService: true,
    };
  }

  const detail = (systemRes.stderr || systemRes.stdout).trim();
  const missing = detail.toLowerCase().includes("not found");
  return {
    status: missing ? "stopped" : "unknown",
    detail: detail || undefined,
    missingUnit: missing,
  };
}

export type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function isSystemctlAvailable(): Promise<boolean> {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) {
    return true;
  }
  const detail = (res.stderr || res.stdout).toLowerCase();
  return !detail.includes("not found");
}

export async function findLegacySystemdUnits(env: GatewayServiceEnv): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable();
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctl(["--user", "is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) {
    return units;
  }

  const systemctlAvailable = await isSystemctlAvailable();
  for (const unit of units) {
    if (systemctlAvailable) {
      await execSystemctl(["--user", "disable", "--now", `${unit.name}.service`]);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
