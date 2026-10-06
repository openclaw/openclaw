/** launchctl state parsing, inspection, and bootstrap primitives. */
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseStrictInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { isStringRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { sleep } from "../utils.js";
import { GATEWAY_SERVICE_KIND } from "./constants.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
  launchctlInspectionReason,
  type LaunchctlResult,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  decodeLaunchdPlistMetadata,
  readLaunchAgentProgramArgumentsFromFile,
  resolveLaunchAgentProgramArguments,
  resolveGeneratedEnvWrapperLayout,
} from "./launchd-plist.js";
import {
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentEnvironmentReadOptions,
} from "./launchd-service-files.js";
import {
  formatSystemLaunchDaemonOwnershipSummary,
  inspectSystemLaunchDaemonOwnership,
} from "./launchd-system.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import {
  ServiceInspectionError,
  type ServiceInspectionReason,
} from "./service-inspection-error.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceReadOptions,
  GatewayServiceState,
} from "./service-types.js";

/** Operation-local facts; never serialized into a command fingerprint or used as control authority. */
export type LoadedLaunchAgentState = GatewayServiceState & {
  launchAgent?: {
    readonly target: string;
    readonly sourcePath: string;
    readonly program: string;
    readonly programArguments: readonly string[];
    readonly workingDirectory?: string;
    readonly environment: Readonly<Record<string, string>>;
  };
};

/** Parse only the selected job's root fields; nested jobs and environments are not its identity. */
export function parseLaunchctlJob(output: string, serviceTarget: string) {
  if (!output.startsWith(`${serviceTarget} = {\n`)) {
    throw new Error(`Cannot parse launchd job ${serviceTarget}`);
  }
  const fields = new Map<string, string>();
  for (const [, name, value] of output.matchAll(/^\t([^\t\n=]+) = (.+)$/gm)) {
    if (fields.has(name!)) {
      throw new Error(`Duplicate launchd job field ${name}`);
    }
    fields.set(name!, value!);
  }
  const block = (name: string) =>
    output.match(new RegExp(`^\\t${name} = \\{\\n([\\s\\S]*?)^\\t\\}`, "m"))?.[1];
  const runtime: LaunchctlPrintInfo = {};
  const state = fields.get("state")?.trim();
  if (state) {
    runtime.state = state;
  }
  const pid = parseStrictPositiveInteger(fields.get("pid"));
  if (pid !== undefined) {
    runtime.pid = pid;
  }
  const status = parseStrictInteger(fields.get("last exit status"));
  if (status !== undefined) {
    runtime.lastExitStatus = status;
  }
  const exitReason = fields.get("last exit reason")?.trim();
  if (exitReason) {
    runtime.lastExitReason = exitReason;
  }
  return {
    fields,
    runtime,
    arguments: block("arguments")
      ?.split("\n")
      .filter((line) => line.startsWith("\t\t"))
      .map((line) => line.slice(2)),
    environment: block("environment") ?? "",
    environmentBlocks: [
      ...output.matchAll(/^\t(?:inherited |default )?environment = \{\n([\s\S]*?)^\t\}/gm),
    ]
      .map((match) => match[1] ?? "")
      .join("\n"),
  };
}

/** Observe the discovered job's loaded command and runtime without granting lifecycle authority. */
export async function readLoadedLaunchAgentState(
  env: GatewayServiceEnv,
  options: { plistPath?: string; timeoutMs?: number } = {},
): Promise<LoadedLaunchAgentState> {
  const label = resolveLaunchAgentLabel(env);
  const expectedPath = options.plistPath ?? resolveLaunchAgentPlistPath(env);
  // Global LaunchAgents also have system file scope, but still run in the GUI domain.
  const domain =
    path.dirname(expectedPath) === "/Library/LaunchDaemons"
      ? "system"
      : resolveLaunchAgentGuiDomain();
  const target = `${domain}/${label}`;
  const result = await execLaunchctl(["print", target], options.timeoutMs ?? 5_000);
  const empty: GatewayServiceState = {
    installed: false,
    loadState: { status: "not-loaded" },
    running: false,
    env,
    command: null,
    runtime: { status: "stopped" },
  };
  if (isLaunchctlNotLoaded(result)) {
    return empty;
  }
  if (result.code !== 0) {
    throw new Error(`Cannot inspect launchd job ${target}: ${formatLaunchctlResultDetail(result)}`);
  }
  const job = parseLaunchctlJob(result.stdout, target);
  const sourcePath = job.fields.get("path");
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error("Loaded LaunchAgent definition path is unavailable.");
  }
  const program = job.fields.get("program");
  if (!program || !path.isAbsolute(program) || !job.arguments?.length) {
    throw new Error("Loaded LaunchAgent command is unavailable.");
  }
  const args = [program, ...job.arguments.slice(1)];
  const layout = resolveGeneratedEnvWrapperLayout(
    args,
    resolveLaunchAgentEnvironmentReadOptions(env, label),
  );
  const environment: Record<string, string> = {};
  for (const line of job.environment.split("\n").filter(Boolean)) {
    const match = /^\t\t([A-Za-z_][A-Za-z0-9_]*) => (.*)$/.exec(line);
    if (!match || Object.hasOwn(environment, match[1]!)) {
      throw new Error("Loaded LaunchAgent environment is unavailable.");
    }
    environment[match[1]!] = match[2]!;
  }
  const command: GatewayServiceCommandConfig = {
    programArguments: layout ? args.slice(layout.commandStartIndex) : args,
    ...(job.fields.get("working directory")
      ? { workingDirectory: job.fields.get("working directory") }
      : {}),
    ...(Object.keys(environment).length ? { environment } : {}),
    sourcePath,
  };
  const parsed = job.runtime;
  const running = parsed.state === "running" || (parsed.pid !== undefined && parsed.pid > 1);
  return {
    installed: true,
    loadState: { status: "loaded" },
    running,
    env: mergeGatewayServiceEnv(env, command),
    command,
    runtime: { ...parsed, status: running ? "running" : "stopped" },
    launchAgent: {
      target,
      sourcePath,
      program,
      programArguments: job.arguments,
      workingDirectory: command.workingDirectory,
      environment,
    },
  };
}

/** A selected package no-restart exemption still requires its current, unchanged definition. */
export async function readCorrespondingLaunchAgentCommand(
  env: GatewayServiceEnv,
  observation: NonNullable<LoadedLaunchAgentState["launchAgent"]>,
  timeoutMs: number,
): Promise<GatewayServiceCommandConfig | null> {
  const label = resolveLaunchAgentLabel(env);
  const plistPath = resolveLaunchAgentPlistPath(env);
  if (
    observation.target !== `${resolveLaunchAgentGuiDomain()}/${label}` ||
    path.resolve(observation.sourcePath) !== path.resolve(plistPath)
  ) {
    return null;
  }
  const plist = await decodeLaunchdPlistMetadata(await fs.readFile(plistPath), timeoutMs);
  const args = plist?.ProgramArguments;
  const environment = plist?.EnvironmentVariables ?? {};
  if (
    !Array.isArray(args) ||
    !args.every((arg): arg is string => typeof arg === "string") ||
    !isStringRecord(environment) ||
    (plist?.Program ?? args[0]) !== observation.program
  ) {
    return null;
  }
  const loadedEnvironment = { ...observation.environment };
  // launchd-current-service recognizes this native label marker. It is not a user override.
  if (
    !Object.hasOwn(environment, "XPC_SERVICE_NAME") &&
    loadedEnvironment.XPC_SERVICE_NAME === label
  ) {
    delete loadedEnvironment.XPC_SERVICE_NAME;
  }
  // launchd adds logging metadata even when the plist declares no environment.
  if (!Object.hasOwn(environment, "OSLogRateLimit")) {
    delete loadedEnvironment.OSLogRateLimit;
  }
  if (
    !isDeepStrictEqual(args, observation.programArguments) ||
    (plist?.WorkingDirectory || undefined) !== observation.workingDirectory ||
    !isDeepStrictEqual(environment, loadedEnvironment)
  ) {
    return null;
  }
  return resolveLaunchAgentProgramArguments(plist, plistPath, {
    ...resolveLaunchAgentEnvironmentReadOptions(env, label),
    requireEffective: true,
    timeoutMs,
  });
}

export async function readLaunchAgentProgramArguments(
  env: GatewayServiceEnv,
  options?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const label = resolveLaunchAgentLabel(env);
  const command = await readLaunchAgentProgramArgumentsFromFile(resolveLaunchAgentPlistPath(env), {
    ...resolveLaunchAgentEnvironmentReadOptions(env, label),
    ...options,
  });
  if (!command && options?.requireEffective) {
    // A removed plist can leave its job registered; only launchd can prove absence.
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 5_000) : 5_000;
    const [probe, system] = await Promise.all([
      probeLaunchAgentState(`${resolveLaunchAgentGuiDomain()}/${label}`, timeoutMs).catch(
        () => null,
      ),
      inspectSystemLaunchDaemonOwnership(label, { timeoutMs, scanInstalledPlists: false }),
    ]);
    if (probe?.state !== "not-loaded") {
      const reason =
        system.status === "loaded" || system.status === "installed"
          ? "launchd-system-owned"
          : ((system.status === "unverifiable" ? system.reason : undefined) ??
            (probe?.state === "unknown" ? probe.inspectionReason : undefined));
      if (reason) {
        throw new ServiceInspectionError(reason);
      }
      throw new Error("Effective LaunchAgent service command could not be inspected.");
    }
  }
  return command;
}

// launchd reserves the label until the outgoing job actually exits, and it
// SIGKILLs that job once ExitTimeOut elapses. Bound the bootstrap retry by that
// same deadline plus slack so a drain-on-SIGTERM gateway cannot outlast it.
const LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_TIMEOUT_MS = (LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 10) * 1_000;
const LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_POLL_MS = 500;
export async function resolveLaunchAgentGatewayContext(env: GatewayServiceEnv): Promise<{
  env: GatewayServiceEnv;
  port: number | null;
  probeHosts: readonly string[];
}> {
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  if (serviceKind && serviceKind !== GATEWAY_SERVICE_KIND) {
    return { env, port: null, probeHosts: [] };
  }
  const command = await readLaunchAgentProgramArguments(env).catch(() => null);
  return {
    env: mergeGatewayServiceEnv(env, command),
    port:
      parseTcpPortFromArgs(command?.programArguments) ??
      parseTcpPort(command?.environment?.OPENCLAW_GATEWAY_PORT ?? "") ??
      parseTcpPort(env.OPENCLAW_GATEWAY_PORT ?? ""),
    probeHosts: await resolveGatewayServiceProbeHosts({ env, command }),
  };
}

export function resolveLaunchAgentGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

export function formatLaunchAgentGuiSessionError(params: {
  detail: string;
  domain: string;
  actionHint: string;
}): string {
  return [
    `launchctl bootstrap failed: ${params.detail}`,
    `LaunchAgent ${params.actionHint} requires a logged-in macOS GUI session for this user (${params.domain}).`,
    "This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
    `Fix: sign in to the macOS desktop as the target user and rerun \`${params.actionHint}\`.`,
    "For headless VM setups, enable auto-login for the target user so macOS creates the GUI session after boot.",
    "Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway",
  ].join("\n");
}

export async function bootstrapLaunchAgentOrThrow(params: {
  domain: string;
  serviceTarget: string;
  plistPath: string;
  actionHint: string;
  onMutation?: (mode: "enable" | "bootstrap") => void;
  skipEnable?: boolean;
  preserveAutoStart?: boolean;
  preservedEnabled?: boolean;
  assertCurrent?: () => void;
  // Opt-in for callers that just issued `bootout` on this label. Only those can
  // race a pending teardown, so start/install/recovery paths keep failing fast
  // on an unrelated EIO instead of waiting out the teardown deadline.
  retryPendingTeardown?: boolean;
}) {
  if (params.preserveAutoStart) {
    params.assertCurrent?.();
    const label = params.serviceTarget.slice(params.domain.length + 1);
    let enabled = params.preservedEnabled;
    if (enabled === undefined) {
      const state = await execLaunchctl(["print-disabled", params.domain]);
      if (state.code !== 0) {
        throw new Error(`launchctl print-disabled failed: ${formatLaunchctlResultDetail(state)}`);
      }
      enabled = parseLaunchAgentEnabled(state.stdout || state.stderr || "", label);
    }
    params.assertCurrent?.();
    if (!enabled) {
      const enable = await execLaunchctl(["enable", params.serviceTarget]);
      if (enable.code !== 0) {
        throw new Error(`launchctl enable failed: ${formatLaunchctlResultDetail(enable)}`);
      }
    }
    const [boot] = await Promise.allSettled([
      bootstrapLaunchAgentOrThrow({ ...params, preserveAutoStart: false, skipEnable: true }),
    ]);
    if (boot.status === "rejected" && hasCommandProcessCleanupError(boot.reason)) {
      throw boot.reason;
    }
    const failures: unknown[] = boot.status === "rejected" ? [boot.reason] : [];
    if (!enabled) {
      try {
        params.assertCurrent?.();
        const disable = await execLaunchctl(["disable", params.serviceTarget]);
        if (disable.code !== 0) {
          throw new Error(
            `LaunchAgent disabled policy could not be restored: ${formatLaunchctlResultDetail(disable)}`,
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "LaunchAgent bootstrap and disabled-policy restoration failed.",
      );
    }
    return;
  }

  // `disable` state survives bootout and plist rewrites; explicit start/repair
  // paths must clear it before asking launchd to load the job again.
  if (!params.skipEnable) {
    params.assertCurrent?.();
    const enable = await execLaunchctl(["enable", params.serviceTarget]);
    if (enable.code === 0) {
      params.onMutation?.("enable");
    }
  }
  const teardownDeadline = Date.now() + LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_TIMEOUT_MS;
  for (;;) {
    params.assertCurrent?.();
    const boot = await execLaunchctl(["bootstrap", params.domain, params.plistPath]);
    if (boot.code === 0) {
      params.onMutation?.("bootstrap");
      return;
    }
    const detail = (boot.stderr || boot.stdout).trim();
    if (isUnsupportedGuiDomain(detail)) {
      throw new Error(
        formatLaunchAgentGuiSessionError({
          detail,
          domain: params.domain,
          actionHint: params.actionHint,
        }),
      );
    }
    if (boot.termination === "exit" && isLaunchctlOperationAlreadyInProgress(detail)) {
      const state = await probeLaunchAgentState(params.serviceTarget);
      if (state.state === "running" || state.state === "stopped") {
        params.onMutation?.("bootstrap");
        return;
      }
    }
    const remainingMs = teardownDeadline - Date.now();
    if (
      !params.retryPendingTeardown ||
      !isLaunchctlBootstrapPendingTeardown(boot) ||
      remainingMs <= 0
    ) {
      throw new Error(`launchctl bootstrap failed: ${detail}`);
    }
    await sleep(Math.min(LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_POLL_MS, remainingMs));
  }
}
type LaunchctlPrintInfo = {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
};

export function parseLaunchAgentEnabled(output: string, label: string): boolean {
  const labelPrefix = `"${label}"`;
  for (const line of output.split("\n")) {
    const entry = line.trim();
    if (!entry.startsWith(labelPrefix)) {
      continue;
    }
    const state = entry.slice(labelPrefix.length).trim();
    if (state === "=> enabled" || state === "=> false") {
      return true;
    }
    if (state === "=> disabled" || state === "=> true") {
      return false;
    }
    throw new Error(`launchctl print-disabled returned an unrecognized state for ${label}`);
  }
  // No persisted override means launchd uses the plist's normal enabled state.
  return true;
}

export async function isLaunchAgentEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(args.env);
  const res = await execLaunchctl(["print-disabled", domain], args.timeoutMs);
  if (res.code !== 0) {
    throw new Error(`launchctl print-disabled failed: ${formatLaunchctlResultDetail(res)}`);
  }
  return parseLaunchAgentEnabled(res.stdout || res.stderr || "", label);
}

export async function isLaunchAgentLoaded(args: GatewayServiceEnvArgs): Promise<boolean> {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(args.env);
  const probe = await probeLaunchAgentState(`${domain}/${label}`, args.timeoutMs);
  if (probe.state === "running" || probe.state === "stopped") {
    return true;
  }
  if (probe.state === "not-loaded") {
    return false;
  }
  if (probe.inspectionReason) {
    throw new ServiceInspectionError(probe.inspectionReason);
  }
  throw new Error(`launchctl print failed: ${probe.detail ?? "unknown error"}`);
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
  opts?: Pick<GatewayServiceEnvArgs, "timeoutMs">,
): Promise<GatewayServiceRuntime> {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const [probe, systemOwnership] = await Promise.all([
    probeLaunchAgentState(`${domain}/${label}`, opts?.timeoutMs),
    inspectSystemLaunchDaemonOwnership(label, { ...opts, scanInstalledPlists: false }),
  ]);
  if (systemOwnership.status !== "absent") {
    return {
      status: "unknown",
      detail: formatSystemLaunchDaemonOwnershipSummary(systemOwnership),
      inspectionReason:
        systemOwnership.status === "unverifiable" ? systemOwnership.reason : "launchd-system-owned",
      systemLaunchDaemon: {
        status: systemOwnership.status,
        serviceTarget: systemOwnership.serviceTarget,
        ...(systemOwnership.status === "installed" ? { plistPath: systemOwnership.plistPath } : {}),
      },
    };
  }
  const plistExists = await launchAgentPlistExists(env);
  if (probe.state === "not-loaded") {
    return plistExists ? { status: "stopped" } : { status: "unknown", missingUnit: true };
  }
  if (probe.state === "unknown") {
    const missingGuiSession = plistExists && isUnsupportedGuiDomain(probe.detail ?? "");
    return {
      status: "unknown",
      detail: probe.detail,
      inspectionReason: probe.inspectionReason,
      ...(missingGuiSession ? { missingGuiSession: true } : {}),
    };
  }
  const parsed = probe.runtime;
  return {
    status: probe.state,
    state: parsed.state,
    pid: parsed.pid,
    lastExitStatus: parsed.lastExitStatus,
    lastExitReason: parsed.lastExitReason,
    cachedLabel: !plistExists,
  };
}

export function isLaunchctlAlreadyLoaded(res: LaunchctlResult): boolean {
  const detail = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return (
    res.termination === "exit" && (res.code === 130 || detail.includes("already exists in domain"))
  );
}

export function isUnsupportedGuiDomain(detail: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.includes("domain does not support specified action") ||
    normalized.includes("could not find domain for user gui") ||
    normalized.includes("bootstrap failed: 125")
  );
}

function isLaunchctlOperationAlreadyInProgress(detail: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.includes("operation already in progress") ||
    normalized.includes("bootstrap failed: 37")
  );
}

function isLaunchctlBootstrapPendingTeardown(res: LaunchctlResult): boolean {
  // `bootout` returns once launchd accepts the request, not once the job is gone,
  // so bootstrapping the same label mid-teardown answers EIO. The plist is valid
  // here, so this is a timing conflict to retry rather than a real I/O fault.
  //
  // launchd answers the same EIO for a label that is simply still registered
  // ("already exists in domain"). That job is not tearing down, so waiting for a
  // teardown that never comes only delays the failure.
  if (res.termination !== "exit" || isLaunchctlAlreadyLoaded(res)) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return normalized.includes("bootstrap failed: 5") || normalized.includes("input/output error");
}
type LaunchAgentProbeResult =
  | { state: "running"; runtime: LaunchctlPrintInfo }
  | { state: "stopped"; runtime: LaunchctlPrintInfo }
  | { state: "not-loaded" }
  | { state: "unknown"; detail?: string; inspectionReason?: ServiceInspectionReason };

export async function probeLaunchAgentState(
  serviceTarget: string,
  timeoutMs?: number,
): Promise<LaunchAgentProbeResult> {
  // `launchctl print` output is not a stable API. Keep expected absence and
  // unexpected failures distinct so every caller applies one classification.
  const probe = await execLaunchctl(["print", serviceTarget], timeoutMs);
  if (probe.code !== 0) {
    if (isLaunchctlNotLoaded(probe)) {
      return { state: "not-loaded" };
    }
    return {
      state: "unknown",
      detail: formatLaunchctlResultDetail(probe) || undefined,
      inspectionReason: launchctlInspectionReason(probe, serviceTarget),
    };
  }
  try {
    const { runtime } = parseLaunchctlJob(probe.stdout || probe.stderr || "", serviceTarget);
    const running =
      normalizeLowercaseStringOrEmpty(runtime.state) === "running" ||
      (typeof runtime.pid === "number" && runtime.pid > 1);
    return { state: running ? "running" : "stopped", runtime };
  } catch (error) {
    return { state: "unknown", detail: formatErrorMessage(error) };
  }
}
