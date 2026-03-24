import { spawnSync } from "node:child_process";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { resolveGatewayWindowsServiceName, resolveNodeWindowsServiceName } from "./constants.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
} from "./service-types.js";

const WINDOWS_SERVICE_LABEL = "Windows service";
const WINDOWS_SERVICE_LOADED_TEXT = "installed";
const WINDOWS_SERVICE_NOT_LOADED_TEXT = "missing";

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type WindowsServiceProbe = {
  serviceName: string;
  qc: CommandResult;
};

function runWindowsCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    code: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error.message || result.error) : ""),
  };
}

export function resolveWindowsServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_WINDOWS_SERVICE_NAME?.trim();
  if (override) {
    return override;
  }
  const kind = env.OPENCLAW_SERVICE_KIND?.trim().toLowerCase();
  if (kind === "node") {
    return resolveNodeWindowsServiceName();
  }
  return resolveGatewayWindowsServiceName(env.OPENCLAW_PROFILE);
}

function readScQc(serviceName: string): CommandResult {
  return runWindowsCommand("sc.exe", ["qc", serviceName]);
}

function readScQueryEx(serviceName: string): CommandResult {
  return runWindowsCommand("sc.exe", ["queryex", serviceName]);
}

function readServiceRegistry(serviceName: string): CommandResult {
  return runWindowsCommand("reg.exe", [
    "query",
    `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`,
    "/s",
  ]);
}

export function isServiceMissingOutput(detail: string): boolean {
  return (
    /\b1060\b/.test(detail) ||
    /does not exist/i.test(detail) ||
    /specified service does not exist/i.test(detail)
  );
}

export function parseScQcOutput(output: string): {
  binaryPathName?: string;
  displayName?: string;
  startType?: string;
  serviceStartName?: string;
} {
  const entries = parseKeyValueOutput(output, ":");
  return {
    binaryPathName: entries.binary_path_name,
    displayName: entries.display_name,
    startType: entries.start_type,
    serviceStartName: entries.service_start_name,
  };
}

export function parseScQueryExOutput(output: string): {
  state?: string;
  pid?: number;
  win32ExitCode?: string;
  serviceExitCode?: string;
} {
  const entries = parseKeyValueOutput(output, ":");
  const pidRaw = entries.pid?.trim();
  const pid = pidRaw && /^\d+$/.test(pidRaw) ? Number.parseInt(pidRaw, 10) : undefined;
  return {
    state: entries.state,
    pid: Number.isFinite(pid) ? pid : undefined,
    win32ExitCode: entries.win32_exit_code,
    serviceExitCode: entries.service_exit_code,
  };
}

export function parseWindowsServiceRegistryParameters(output: string): {
  application?: string;
  appParameters?: string;
  appDirectory?: string;
} {
  const lines = output.split(/\r?\n/);
  let inParameters = false;
  const parsed: {
    application?: string;
    appParameters?: string;
    appDirectory?: string;
  } = {};

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith("HKEY_")) {
      inParameters = /\\Parameters$/i.test(line.trim());
      continue;
    }
    if (!inParameters) {
      continue;
    }
    const match = line.match(/^\s*([^\s]+)\s+REG_[A-Z0-9_]+\s+(.*)$/i);
    if (!match) {
      continue;
    }
    const [, name, value] = match;
    if (name === "Application") {
      parsed.application = value.trim();
    } else if (name === "AppParameters") {
      parsed.appParameters = value.trim();
    } else if (name === "AppDirectory") {
      parsed.appDirectory = value.trim();
    }
  }

  return parsed;
}

function buildWindowsServiceCommandConfig(
  serviceName: string,
  qcOutput: string,
  registryOutput: string,
): GatewayServiceCommandConfig | null {
  const qc = parseScQcOutput(qcOutput);
  const parameters = parseWindowsServiceRegistryParameters(registryOutput);
  const programArguments = (() => {
    if (parameters.application) {
      return [
        parameters.application,
        ...splitArgsPreservingQuotes(parameters.appParameters ?? "", {
          escapeMode: "backslash-quote-only",
        }),
      ];
    }
    if (qc.binaryPathName) {
      return splitArgsPreservingQuotes(qc.binaryPathName, {
        escapeMode: "backslash-quote-only",
      });
    }
    return [];
  })();

  if (programArguments.length === 0) {
    return null;
  }

  return {
    programArguments,
    ...(parameters.appDirectory ? { workingDirectory: parameters.appDirectory } : {}),
    sourcePath: `service:${serviceName}`,
    label: WINDOWS_SERVICE_LABEL,
    loadedText: WINDOWS_SERVICE_LOADED_TEXT,
    notLoadedText: WINDOWS_SERVICE_NOT_LOADED_TEXT,
    environment: {
      OPENCLAW_WINDOWS_SERVICE_NAME: serviceName,
    },
  };
}

export async function isWindowsServiceInstalled(args: GatewayServiceEnvArgs): Promise<boolean> {
  return (await probeWindowsService(args.env)) !== null;
}

export async function probeWindowsService(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<WindowsServiceProbe | null> {
  const serviceName = resolveWindowsServiceName(env);
  const qc = readScQc(serviceName);
  if (qc.code !== 0) {
    return null;
  }
  return { serviceName, qc };
}

export async function readWindowsServiceCommand(
  env: GatewayServiceEnv,
  probe?: WindowsServiceProbe,
): Promise<GatewayServiceCommandConfig | null> {
  const detected = probe ?? (await probeWindowsService(env));
  if (!detected) {
    return null;
  }
  const { serviceName, qc } = detected;
  if (qc.code !== 0) {
    return null;
  }
  const registry = readServiceRegistry(serviceName);
  return buildWindowsServiceCommandConfig(serviceName, qc.stdout, registry.stdout);
}

function deriveWindowsServiceRuntimeStatus(state?: string): GatewayServiceRuntime["status"] {
  const normalized = state?.toLowerCase() ?? "";
  if (normalized.includes("running")) {
    return "running";
  }
  if (normalized.includes("stopped")) {
    return "stopped";
  }
  return "unknown";
}

export async function readWindowsServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  const serviceName = resolveWindowsServiceName(env);
  const result = readScQueryEx(serviceName);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    const missing = isServiceMissingOutput(detail);
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseScQueryExOutput(result.stdout);
  return {
    status: deriveWindowsServiceRuntimeStatus(parsed.state),
    state: parsed.state,
    ...(parsed.pid && parsed.pid > 0 ? { pid: parsed.pid } : {}),
    ...(parsed.win32ExitCode ? { lastExitReason: parsed.win32ExitCode } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServiceState(
  serviceName: string,
  matcher: (state?: string) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const query = parseScQueryExOutput(readScQueryEx(serviceName).stdout);
    if (matcher(query.state)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

export async function stopWindowsService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const serviceName = resolveWindowsServiceName(effectiveEnv);
  const result = runWindowsCommand("sc.exe", ["stop", serviceName]);
  const detail = (result.stderr || result.stdout).trim();
  if (result.code !== 0 && !/service has not been started/i.test(detail)) {
    throw new Error(`sc stop failed: ${detail || "unknown error"}`.trim());
  }
  await waitForServiceState(
    serviceName,
    (state) => state?.toLowerCase().includes("stopped") ?? false,
  );
  stdout.write(`Stopped Windows service: ${serviceName}\n`);
}

export async function restartWindowsService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const effectiveEnv = env ?? (process.env as GatewayServiceEnv);
  const serviceName = resolveWindowsServiceName(effectiveEnv);
  const stopResult = runWindowsCommand("sc.exe", ["stop", serviceName]);
  const stopDetail = (stopResult.stderr || stopResult.stdout).trim();
  if (stopResult.code !== 0 && !/service has not been started/i.test(stopDetail)) {
    throw new Error(`sc stop failed: ${stopDetail || "unknown error"}`.trim());
  }
  await waitForServiceState(
    serviceName,
    (state) => state?.toLowerCase().includes("stopped") ?? false,
  );
  const startResult = runWindowsCommand("sc.exe", ["start", serviceName]);
  if (startResult.code !== 0) {
    const detail = (startResult.stderr || startResult.stdout).trim();
    throw new Error(`sc start failed: ${detail || "unknown error"}`.trim());
  }
  await waitForServiceState(
    serviceName,
    (state) => state?.toLowerCase().includes("running") ?? false,
  );
  stdout.write(`Restarted Windows service: ${serviceName}\n`);
  return { outcome: "completed" };
}

export async function uninstallWindowsService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  const serviceName = resolveWindowsServiceName(env);
  const result = runWindowsCommand("sc.exe", ["delete", serviceName]);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`sc delete failed: ${detail || "unknown error"}`.trim());
  }
  stdout.write(`Removed Windows service: ${serviceName}\n`);
}
