/** Installed systemd scope discovery and dueling-manager diagnostics. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeHomeDirValue } from "@openclaw/normalization-core/home-dir";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { buildParseArgv } from "../cli/argv.js";
import { isValidProfileName, normalizeProfileName } from "../cli/profile-utils.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "../cli/profile.js";
import {
  isDefaultInstallIdentity,
  isNamedProfile,
  parseGatewayPortEnvValue,
  resolveConfigPathCandidate,
  resolveStateDir,
} from "../config/paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { GATEWAY_SERVICE_KIND, isGatewayServiceEnv } from "./constants.js";
import { resolveDaemonHomeDir } from "./paths.js";
import { isBunRuntime, isNodeRuntime } from "./runtime-binary.js";
import { findServiceOwnershipRefusal, ServiceInspectionError } from "./service-inspection-error.js";
import { resolveServiceEntrypointIndex, summarizeGatewayServiceLayout } from "./service-layout.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceReadOptions,
  SystemdGatewayInstallation,
  SystemdServiceReadTarget,
} from "./service-types.js";
import { execSystemctl, isSystemdUnitActive } from "./systemd-exec.js";
import {
  readSystemdServiceExecStart,
  resolveInstalledSystemdServiceNameCandidates,
  resolveSystemdServiceName,
  resolveSystemdUnitPathForName,
} from "./systemd-service-files.js";
import { assertNoSystemSystemdOwnership, isSystemSystemdOwnershipError } from "./systemd-system.js";

const SYSTEM_SYSTEMD_UNIT_DIRS = [
  "/etc/systemd/system",
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
] as const;

type SystemdDiscoveryOptions = Pick<
  GatewayServiceReadOptions,
  "requireLoaded" | "loadForInspection" | "timeoutMs"
>;

/** Proves service absence without interpreting failed manager commands as absence. */
export async function isSystemdServiceAbsent(
  env: GatewayServiceEnv,
  opts?: { timeoutMs?: number; strictCommandAbsent?: true },
): Promise<boolean> {
  if (opts?.strictCommandAbsent) {
    // The caller just proved user-unit absence without loading it. System
    // ownership needs its own live manager and complete unit-path inspection.
    try {
      await assertNoSystemSystemdOwnership(
        `${resolveSystemdServiceName(env)}.service`,
        opts.timeoutMs,
        { requireLoaded: true },
      );
    } catch (error) {
      // A present or unverifiable system owner prevents absence proof; it is
      // not a refusal of this read-only inspection's admitted manager binding.
      if (isSystemSystemdOwnershipError(error)) {
        return false;
      }
      throw error;
    }
    return (
      (await findInstalledSystemdGatewayScope(env, {
        requireLoaded: true,
        timeoutMs: opts.timeoutMs,
      })) === null
    );
  }
  if (
    env.DBUS_SESSION_BUS_ADDRESS ||
    env.DBUS_SYSTEM_BUS_ADDRESS ||
    env.SYSTEMD_UNIT_PATH ||
    env.SUDO_USER ||
    isGatewayServiceEnv(env) ||
    typeof process.geteuid !== "function"
  ) {
    return false;
  }
  const home = resolveDaemonHomeDir(env);
  const runtimeDirs = new Set(
    [`/run/user/${process.geteuid()}`, env.XDG_RUNTIME_DIR].filter((value): value is string =>
      Boolean(value),
    ),
  );
  const configHome = env.XDG_CONFIG_HOME || path.posix.join(home, ".config");
  const dataHome = env.XDG_DATA_HOME || path.posix.join(home, ".local/share");
  const userRoots = [
    path.posix.join(home, ".config"),
    configHome,
    dataHome,
    ...(env.XDG_CONFIG_DIRS || "/etc/xdg").split(":"),
    ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
    "/etc",
    "/usr/local/lib",
    "/usr/lib",
    "/lib",
  ];
  const unitName = `${resolveSystemdServiceName(env)}.service`;
  if (![...runtimeDirs, ...userRoots].every((dir) => path.posix.isAbsolute(dir))) {
    return false;
  }
  // sd_booted() uses /run/systemd/system; user managers own runtime/systemd/private.
  // Require the complete runtime directory absent so transient/generated units cannot hide.
  const absentPaths = [
    "/run/systemd",
    ...[...runtimeDirs].map((dir) => path.posix.join(dir, "systemd")),
    ...userRoots.flatMap((dir) =>
      ["user", "user.control", "user.attached"].map((scope) =>
        path.posix.join(dir, "systemd", scope, unitName),
      ),
    ),
    ...["/etc", "/usr/local/lib", "/usr/lib", "/lib"].flatMap((dir) =>
      ["system", "system.control", "system.attached"].map((scope) =>
        path.posix.join(dir, "systemd", scope, unitName),
      ),
    ),
  ];
  for (const candidate of absentPaths) {
    try {
      await fs.lstat(candidate);
      return false;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        return false;
      }
    }
  }
  return (await findInstalledSystemdGatewayScope(env)) === null;
}

function unitBaseName(label: string): string {
  return label.endsWith(".service") ? label.slice(0, -".service".length) : label;
}

function systemdTemplatePrefix(base: string): { template: string; instance: string } | null {
  const cut = base.indexOf("@");
  if (cut <= 0) {
    return null;
  }
  return { template: base.slice(0, cut), instance: base.slice(cut + 1) };
}

function systemdInstalledNameProbes(names: string[]): string[] {
  return [
    ...new Set([
      ...names,
      ...names.flatMap((name) => {
        const parsed = systemdTemplatePrefix(name);
        return parsed?.instance ? [`${parsed.template}@`] : [];
      }),
    ]),
  ];
}

function systemdUnitMatchesIdentity(
  label: string,
  allowedNames: Set<string>,
  explicit: boolean,
): boolean {
  const base = unitBaseName(label);
  if (allowedNames.has(base)) {
    return true;
  }
  const parsed = systemdTemplatePrefix(base);
  if (!parsed) {
    return false;
  }
  const { template, instance } = parsed;
  // Default-profile system templates such as openclaw@.service / openclaw@gateway.service.
  if (!explicit && allowedNames.has(template) && (instance === "" || instance === "gateway")) {
    return true;
  }
  // Explicit OPENCLAW_SYSTEMD_UNIT=openclaw@gateway.service may only have the
  // backing template installed; keep the requested instance for inspection.
  if (instance !== "") {
    return false;
  }
  const prefix = `${template}@`;
  for (const name of allowedNames) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return true;
    }
  }
  return false;
}

function resolveSystemdTemplateInstanceName(unitName: string, env: GatewayServiceEnv): string {
  if (!unitName.endsWith("@.service")) {
    return unitName;
  }
  const template = unitName.slice(0, -"@.service".length);
  const requested = resolveSystemdServiceName(env);
  const parsed = systemdTemplatePrefix(requested);
  const instance =
    parsed && parsed.template === template && parsed.instance
      ? parsed.instance
      : os.userInfo().username;
  return `${template}@${instance}.service`;
}

async function findSystemSystemdUnitPath(
  env: GatewayServiceEnv,
): Promise<{ unitName: string; unitPath: string } | null> {
  const candidates = systemdInstalledNameProbes(resolveInstalledSystemdServiceNameCandidates(env));
  for (const name of candidates) {
    const serviceFile = `${name}.service`;
    for (const dir of SYSTEM_SYSTEMD_UNIT_DIRS) {
      const candidate = path.posix.join(dir, serviceFile);
      try {
        await fs.access(candidate);
        return { unitName: serviceFile, unitPath: candidate };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function assertNoSystemGatewayOwnership(
  env: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<void> {
  if (env.OPENCLAW_SERVICE_KIND?.trim() === "node") {
    return;
  }
  await assertNoSystemSystemdOwnership(`${resolveSystemdServiceName(env)}.service`, timeoutMs);
}

/**
 * Activation admission after the system-scope probe refused. An unverifiable
 * probe cannot make a loaded user unit whose artifacts this account owns a
 * competing manager; a proven system owner and an unloaded or foreign user unit
 * still refuse with the original error.
 */
export async function admitUserUnitActivationPastUnverifiableOwnership(
  env: GatewayServiceEnv,
  error: unknown,
  timeoutMs?: number,
): Promise<void> {
  if (!isSystemSystemdOwnershipError(error) || error.ownership.status !== "unverifiable") {
    throw error;
  }
  const { readSystemdDefinitionMutationCapability } =
    await import("./systemd-definition-mutation.js");
  const capability = await readSystemdDefinitionMutationCapability(env, {
    requireLoaded: true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }).catch(() => undefined);
  if (capability?.kind !== "writable") {
    throw error;
  }
}

export async function assertNoSystemGatewayOwnershipForActivation(
  env: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<void> {
  try {
    await assertNoSystemGatewayOwnership(env, timeoutMs);
  } catch (error) {
    await admitUserUnitActivationPastUnverifiableOwnership(env, error, timeoutMs);
  }
}

async function readSystemdGatewayCommand(
  env: GatewayServiceEnv,
  target: SystemdServiceReadTarget,
  options?: SystemdDiscoveryOptions,
): Promise<(GatewayServiceCommandConfig & { environment: GatewayServiceEnv }) | null> {
  let command: GatewayServiceCommandConfig | null;
  try {
    command = await readSystemdServiceExecStart(env, {
      ...options,
      systemdReadTarget: target,
      requireEffective: true,
    });
  } catch (error) {
    if (findServiceOwnershipRefusal(error)?.reason === "systemd-account-refused") {
      return null;
    }
    throw error;
  }
  if (!command) {
    return null;
  }
  // Resolve selectors in the service's environment and cwd, never the inspecting CLI's.
  const serviceEnv = { ...command.environment };
  const accountHome = () => os.userInfo().homedir;
  const cwd = command.workingDirectory || (target.scope === "system" ? "/" : accountHome());
  for (const key of [
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
  ]) {
    const value =
      key === "OPENCLAW_STATE_DIR" || key === "OPENCLAW_CONFIG_PATH"
        ? serviceEnv[key]?.trim()
        : normalizeHomeDirValue(serviceEnv[key]);
    if (value && !path.isAbsolute(value) && !/^~(?:$|[\\/])/.test(value)) {
      serviceEnv[key] = path.resolve(cwd, value);
    }
  }
  const kind = serviceEnv.OPENCLAW_SERVICE_KIND?.trim();
  if (kind && kind !== GATEWAY_SERVICE_KIND) {
    return null;
  }
  const executable = command.programArguments[0] ?? "";
  const runtime = isNodeRuntime(executable) || isBunRuntime(executable);
  const profile = parseCliProfileArgs(
    buildParseArgv(command.programArguments, runtime ? "openclaw" : executable),
  );
  if (!profile.ok) {
    throw new Error("Systemd Gateway profile could not be inspected. Set OPENCLAW_SYSTEMD_UNIT.");
  }
  if (profile.profile) {
    applyCliProfileEnv({ profile: profile.profile, env: serviceEnv, homedir: accountHome });
  }
  const programArguments = runtime ? profile.argv : [executable, ...profile.argv.slice(2)];
  const entrypointIndex = resolveServiceEntrypointIndex(programArguments);
  if (entrypointIndex !== undefined && programArguments[entrypointIndex + 1] === "node") {
    return null;
  }
  return { ...command, programArguments, environment: serviceEnv };
}

async function inspectSystemdGatewayCommandLayout(
  command: GatewayServiceCommandConfig,
): Promise<string> {
  const executable = command.programArguments[0] ?? "";
  const runtime = isNodeRuntime(executable) || isBunRuntime(executable);
  const entrypointIndex = resolveServiceEntrypointIndex(command.programArguments);
  const layout = await summarizeGatewayServiceLayout(command);
  if (!layout?.packageRoot || (!runtime && entrypointIndex !== 0)) {
    throw new Error("Systemd Gateway launcher identity is unknown. Set OPENCLAW_SYSTEMD_UNIT.");
  }
  if (!command.sourcePath) {
    throw new Error(
      "Systemd Gateway definition could not be inspected. Set OPENCLAW_SYSTEMD_UNIT.",
    );
  }
  return command.sourcePath;
}

async function systemdInstallationIdentity(env: GatewayServiceEnv): Promise<string> {
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && !isValidProfileName(profile)) {
    throw new Error("Systemd Gateway profile could not be inspected.");
  }
  const home = () => os.userInfo().homedir;
  const paths = await Promise.all(
    [
      resolveRequiredHomeDir(env, home),
      resolveStateDir(env, home),
      resolveConfigPathCandidate(env, home),
    ].map(async (pathname) => {
      try {
        return await fs.realpath(pathname);
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return path.resolve(pathname);
      }
    }),
  );
  return JSON.stringify([normalizeProfileName(profile), ...paths]);
}

function systemdGatewayCommandPort(command: GatewayServiceCommandConfig): number | null {
  const port = parseTcpPortFromArgs(command.programArguments);
  const envPort = command.environment?.OPENCLAW_GATEWAY_PORT?.trim();
  if (
    command.programArguments.some((arg) => arg === "--port" || arg.startsWith("--port=")) &&
    port === null
  ) {
    throw new Error("Systemd Gateway port could not be inspected.");
  }
  return port ?? parseGatewayPortEnvValue(envPort);
}

async function systemdUnitsShareInstallation(
  env: GatewayServiceEnv,
  user: SystemdServiceReadTarget,
  system: SystemdServiceReadTarget,
  options: SystemdDiscoveryOptions | undefined,
  deadline: number | undefined,
): Promise<boolean> {
  const inspection = options?.loadForInspection;
  const assertInspectionCurrent = inspection?.assertReadCurrent ?? inspection?.assertCurrent;
  const assertCurrent = () => {
    assertInspectionCurrent?.();
    if (deadline !== undefined && performance.now() >= deadline) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
  };
  assertCurrent();
  const selected = await systemdInstallationIdentity(env);
  assertCurrent();
  let port: number | null | undefined;
  for (const target of [system, user]) {
    assertCurrent();
    const remaining = deadline === undefined ? undefined : deadline - performance.now();
    if (remaining !== undefined && remaining <= 0) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    // Duplicate proof cannot transfer one manager's LoadUnit grant to its peer.
    const command = await readSystemdGatewayCommand(env, target, {
      requireLoaded: true,
      timeoutMs: remaining,
    });
    assertCurrent();
    if (!command) {
      return false;
    }
    const identity = await systemdInstallationIdentity(command.environment);
    assertCurrent();
    if (identity !== selected) {
      return false;
    }
    await inspectSystemdGatewayCommandLayout(command);
    assertCurrent();
    const commandPort = systemdGatewayCommandPort(command);
    // An explicit port and an unspecified config port are not proven equivalent.
    if (port !== undefined && port !== commandPort) {
      return false;
    }
    port = commandPort;
  }
  return true;
}

async function findMarkerOwnedSystemSystemdUnit(
  env: GatewayServiceEnv,
  options: SystemdDiscoveryOptions | undefined,
  discoverCustom: boolean,
): Promise<SystemdServiceReadTarget | null> {
  const deadline =
    options?.timeoutMs && options.timeoutMs > 0 ? performance.now() + options.timeoutMs : undefined;
  const allowedNames = new Set(resolveInstalledSystemdServiceNameCandidates(env));
  const allowCustom =
    discoverCustom &&
    !env.OPENCLAW_SYSTEMD_UNIT?.trim() &&
    !isNamedProfile(env) &&
    isDefaultInstallIdentity(env);
  const custom = new Map<string, SystemdServiceReadTarget>();

  const { findSystemGatewayServices } = await import("./inspect.js");
  let services: Awaited<ReturnType<typeof findSystemGatewayServices>>;
  try {
    services = await findSystemGatewayServices();
  } catch {
    return null;
  }
  for (const svc of services) {
    if (
      svc.platform !== "linux" ||
      svc.scope !== "system" ||
      svc.marker !== "openclaw" ||
      !svc.label?.endsWith(".service")
    ) {
      continue;
    }
    const match = /^unit:\s*(.+)$/.exec(svc.detail.trim());
    const unitPath = match?.[1]?.trim();
    if (unitPath) {
      const target: SystemdServiceReadTarget = {
        scope: "system",
        unitName: resolveSystemdTemplateInstanceName(svc.label, env),
        unitPath,
      };
      if (
        systemdUnitMatchesIdentity(
          svc.label,
          allowedNames,
          Boolean(env.OPENCLAW_SYSTEMD_UNIT?.trim()),
        )
      ) {
        return target;
      }
      if (allowCustom && !custom.has(target.unitName)) {
        custom.set(target.unitName, target);
      }
    }
  }
  let found: SystemdServiceReadTarget | null = null;
  for (const target of custom.values()) {
    const remaining = deadline === undefined ? undefined : deadline - performance.now();
    if (remaining !== undefined && remaining <= 0) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    const command = await readSystemdGatewayCommand(env, target, {
      ...options,
      timeoutMs: remaining ?? options?.timeoutMs,
    });
    if (
      !command ||
      isNamedProfile(command.environment) ||
      !isDefaultInstallIdentity(command.environment)
    ) {
      continue;
    }
    const sourcePath = await inspectSystemdGatewayCommandLayout(command);
    if (found) {
      throw new Error(
        "Multiple systemd Gateway units use this installation. Set OPENCLAW_SYSTEMD_UNIT.",
      );
    }
    found = { ...target, unitPath: sourcePath };
  }
  return found;
}

async function findUserSystemdGatewayScope(
  env: GatewayServiceEnv,
): Promise<SystemdServiceReadTarget | null> {
  const candidates = resolveInstalledSystemdServiceNameCandidates(env);
  for (const name of candidates) {
    try {
      const userPath = resolveSystemdUnitPathForName(env, name);
      await fs.access(userPath);
      return { scope: "user", unitName: `${name}.service`, unitPath: userPath };
    } catch {
      continue;
    }
  }
  return null;
}

async function findSystemSystemdGatewayScope(
  env: GatewayServiceEnv,
  options: SystemdDiscoveryOptions | undefined,
  discoverCustom: boolean,
): Promise<SystemdServiceReadTarget | null> {
  const systemUnit = await findSystemSystemdUnitPath(env);
  if (systemUnit) {
    return {
      scope: "system",
      unitName: resolveSystemdTemplateInstanceName(systemUnit.unitName, env),
      unitPath: systemUnit.unitPath,
    };
  }
  if (env.OPENCLAW_SERVICE_KIND?.trim() === "node") {
    return null;
  }
  // System-scope installs may use a non-canonical unit name for the default
  // profile; fall back to a marker-owned lookup. Profile-scoped installs only
  // accept units that match their candidate names (never an unrelated agent).
  return await findMarkerOwnedSystemSystemdUnit(env, options, discoverCustom);
}

/** Keep matching user/system units visible so Doctor can diagnose dueling managers. */
export async function findSystemdGatewayInstallation(
  env: GatewayServiceEnv,
  options?: SystemdDiscoveryOptions,
): Promise<SystemdGatewayInstallation> {
  const deadline =
    options?.timeoutMs && options.timeoutMs > 0 ? performance.now() + options.timeoutMs : undefined;
  const user = await findUserSystemdGatewayScope(env);
  // With a user unit present, only this profile's known system aliases compete.
  const system = await findSystemSystemdGatewayScope(env, options, !user);
  if (user) {
    if (system && (await systemdUnitsShareInstallation(env, user, system, options, deadline))) {
      return { kind: "dueling", user, system };
    }
    return { kind: "user", user };
  }
  if (system) {
    return { kind: "system", system };
  }
  return { kind: "none" };
}

/** Lifecycle stays user-first; Doctor separately resolves matching dueling units. */
export async function findInstalledSystemdGatewayScope(
  env: GatewayServiceEnv,
  options?: SystemdDiscoveryOptions,
): Promise<SystemdServiceReadTarget | null> {
  const user = await findUserSystemdGatewayScope(env);
  if (user) {
    return user;
  }
  return await findSystemSystemdGatewayScope(env, options, true);
}

/** Doctor may remove a duplicate only when the system unit runs now and survives reboot. */
export async function isSystemUnitActiveAndEnabled(
  env: GatewayServiceEnv,
  unitName: string,
): Promise<boolean> {
  const active = await isSystemdUnitActive(env, unitName, "system");
  if (!active.ok || !active.value) {
    return false;
  }
  const res = await execSystemctl(["is-enabled", unitName], env);
  if (res.code !== 0) {
    return false;
  }
  // `is-enabled` also exits 0 for enabled-runtime, alias, static, indirect,
  // generated, and transient (systemctl(1) Table 3). Only a plain `enabled`
  // symlink survives a reboot, so anything else must not authorize deleting
  // the user unit.
  return normalizeLowercaseStringOrEmpty(res.stdout) === "enabled";
}

export function formatDuelingScopesWarning(
  installation: SystemdGatewayInstallation,
  port: number,
): string | null {
  if (installation.kind !== "dueling") {
    return null;
  }
  const { user, system } = installation;
  // Deliberately no copy-paste removal command: this formatter has no ownership
  // evidence, and blindly deleting the user unit can remove the only working
  // gateway. Guided Doctor decides that behind the active+enabled probe.
  return (
    `detected BOTH a user-scope (${user.unitPath}) and a system-scope (${system.unitPath}) ` +
    `gateway unit bound to port ${port}; they will SIGTERM each other in a restart loop. ` +
    `Run \`openclaw doctor\` interactively to inspect both scopes and review supported cleanup.`
  );
}
