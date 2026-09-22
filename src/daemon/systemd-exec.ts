/** systemctl execution, user-manager routing, and availability probes. */
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../shared/regexp.js";
import { execFileUtf8, type ExecResult } from "./exec-file.js";
import {
  ServiceInspectionError,
  type ServiceInspectionReason,
} from "./service-inspection-error.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  classifySystemdUnavailableDetail,
  isSystemctlMissingDetail,
  isSystemdUserBusUnavailableDetail,
} from "./systemd-unavailable.js";
import {
  resolveSystemdUserTransport,
  SYSTEMD_TRANSPORT_DEADLINE,
} from "./systemd-user-transport.js";

type SystemdExecResult = ExecResult & { inspectionReason?: ServiceInspectionReason };

export type SystemdUnitScope = "system" | "user";

async function execSystemdCommand(
  command: "systemctl" | "busctl",
  args: string[],
  env?: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<ExecResult> {
  return await execFileUtf8(command, args, {
    env: env ? { ...process.env, ...env } : process.env,
    // A wedged systemd socket can leave manager commands blocked forever; the timeout
    // kills the child so status reads fail soft instead of hanging the command.
    ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
}

export async function execSystemctl(
  args: string[],
  env?: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<ExecResult> {
  return await execSystemdCommand("systemctl", args, env, timeoutMs);
}

/** System-manager reads never inherit user-bus routing. */
export async function execBusctlSystem(args: string[], timeoutMs?: number): Promise<ExecResult> {
  return await execSystemdCommand("busctl", ["--system", ...args], undefined, timeoutMs);
}

export function readSystemctlDetail(result: { stdout: string; stderr: string }): string {
  // Unit status can be in stdout while stderr contains a launcher diagnostic.
  return `${result.stderr} ${result.stdout}`.trim();
}

export function systemdInspectionError(
  result: SystemdExecResult,
  fallback: string,
  scope: SystemdUnitScope = "user",
): Error {
  if (result.inspectionReason) {
    return new ServiceInspectionError(result.inspectionReason);
  }
  if (result.termination === "error" && ["EACCES", "EPERM"].includes(result.errorCode ?? "")) {
    return new ServiceInspectionError("service-manager-access-denied");
  }
  if (
    scope === "system" &&
    result.termination === "exit" &&
    readSystemctlDetail(result).includes("System has not been booted with systemd")
  ) {
    return new ServiceInspectionError("service-manager-unavailable");
  }
  if (
    scope === "user" &&
    result.termination === "exit" &&
    isSystemdUserBusUnavailableDetail(readSystemctlDetail(result))
  ) {
    return new ServiceInspectionError("systemd-user-bus-unavailable");
  }
  return new Error(fallback);
}

export function isSystemctlMissing(result: ExecResult): boolean {
  return (
    result.errorCode === "ENOENT" ||
    result.errorCode === "EACCES" ||
    (result.termination === "exit" && isSystemctlMissingDetail(readSystemctlDetail(result)))
  );
}

export function isSystemdUnitNotEnabled(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.includes("disabled") ||
    normalized.includes("static") ||
    normalized.includes("indirect") ||
    normalized.includes("masked") ||
    normalized.includes("not-found") ||
    normalized.includes("could not be found") ||
    normalized.includes("failed to get unit file state")
  );
}

export function isSystemdUnitMissingDetail(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    (normalized.includes("unit file") && normalized.includes("does not exist")) ||
    normalized.includes("not-found") ||
    normalized.includes("could not be found")
  );
}

function isSystemdUnitAlreadyMissingOrInactive(detail: string, unitName: string): boolean {
  const escapedUnitName = escapeRegExp(normalizeLowercaseStringOrEmpty(unitName));
  return new RegExp(
    `^(?:failed to (?:disable unit|stop\\s+${escapedUnitName}):\\s*)?` +
      `(?:unit file\\s+${escapedUnitName}\\s+does not exist|` +
      `unit\\s+${escapedUnitName}(?:\\s+is)?\\s+` +
      `(?:inactive|not\\s+active|not\\s+loaded|not-found|could not be found))[.!]?$`,
    "u",
  ).test(normalizeLowercaseStringOrEmpty(detail));
}

const isSystemctlBusUnavailable = isSystemdUserBusUnavailableDetail;

export function isSystemdUserScopeUnavailable(detail: string): boolean {
  return classifySystemdUnavailableDetail(detail) !== null;
}

function isGenericSystemctlIsEnabledFailure(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.startsWith("command failed: systemctl") &&
    normalized.includes(" is-enabled ") &&
    !normalized.includes("permission denied") &&
    !normalized.includes("access denied") &&
    !normalized.includes("no space left") &&
    !normalized.includes("read-only file system") &&
    !normalized.includes("out of memory") &&
    !normalized.includes("cannot allocate memory")
  );
}

export function isNonFatalSystemdInstallProbeError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return isSystemctlBusUnavailable(normalized) || isGenericSystemctlIsEnabledFailure(normalized);
}

async function execSystemdUserCommand(
  command: "systemctl" | "busctl",
  env: GatewayServiceEnv,
  args: string[],
  timeoutMs?: number,
  assertCurrent?: () => void,
): Promise<SystemdExecResult> {
  const deadline = timeoutMs && timeoutMs > 0 ? performance.now() + timeoutMs : undefined;
  try {
    const transport = await resolveSystemdUserTransport(env, deadline, assertCurrent);
    if (transport?.kind === "private" && command === "busctl") {
      throw new ServiceInspectionError("systemd-user-bus-unavailable");
    }
    const childEnv =
      !transport || transport.kind === "machine"
        ? env
        : {
            ...env,
            // systemctl otherwise prefers its private socket over the selected broker.
            XDG_RUNTIME_DIR:
              transport.kind === "private" || command === "busctl"
                ? transport.runtimeDir
                : undefined,
            DBUS_SESSION_BUS_ADDRESS: transport.address,
          };
    assertCurrent?.();
    const remaining = deadline === undefined ? undefined : Math.ceil(deadline - performance.now());
    if (remaining !== undefined && remaining <= 0) {
      return {
        code: 1,
        termination: "timeout",
        stdout: "",
        stderr: "systemd user manager command deadline expired",
      };
    }
    const scope =
      transport?.kind === "machine" ? ["--machine", `${transport.user}@`, "--user"] : ["--user"];
    return await execSystemdCommand(command, [...scope, ...args], childEnv, remaining);
  } catch (error) {
    assertCurrent?.();
    if (!(error instanceof ServiceInspectionError)) {
      throw error;
    }
    return {
      code: 1,
      termination: error === SYSTEMD_TRANSPORT_DEADLINE ? "timeout" : "error",
      stdout: "",
      stderr: error.message,
      inspectionReason: error.reason,
    };
  }
}

export async function execSystemctlUser(
  env: GatewayServiceEnv,
  args: string[],
  timeoutMs?: number,
  assertCurrent?: () => void,
): Promise<SystemdExecResult> {
  return await execSystemdUserCommand("systemctl", env, args, timeoutMs, assertCurrent);
}

export async function execBusctlUser(
  env: GatewayServiceEnv,
  args: string[],
  timeoutMs?: number,
  assertCurrent?: () => void,
): Promise<SystemdExecResult> {
  return await execSystemdUserCommand("busctl", env, args, timeoutMs, assertCurrent);
}

export async function disableSystemdUserUnitForRemoval(
  env: GatewayServiceEnv,
  unitName: string,
): Promise<void> {
  const result = await execSystemctlUser(env, ["disable", "--now", unitName]);
  if (result.code === 0) {
    return;
  }
  const detail = readSystemctlDetail(result);
  if (result.termination === "exit" && isSystemdUnitAlreadyMissingOrInactive(detail, unitName)) {
    return;
  }
  throw new Error(`systemctl disable failed: ${detail || "unknown error"}`);
}

export async function reloadSystemdUserManager(
  env: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<void> {
  const result = await execSystemctlUser(env, ["daemon-reload"], timeoutMs);
  if (result.code !== 0) {
    throw new Error(
      `systemctl daemon-reload failed: ${readSystemctlDetail(result) || "unknown error"}`,
    );
  }
}

export async function isSystemdUserServiceAvailable(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<boolean> {
  const res = await execSystemctlUser(env, ["status"]);
  const detail = readSystemctlDetail(res);
  return (
    res.termination === "exit" &&
    (res.code === 0 || (Boolean(detail) && !isSystemdUserScopeUnavailable(detail)))
  );
}

export async function isSystemdUnitActive(
  env: GatewayServiceEnv,
  unitName: string,
  scope: SystemdUnitScope = "user",
): Promise<Result<boolean, string>> {
  const normalizedUnit = unitName.trim();
  if (!normalizedUnit) {
    return ok(false);
  }
  const args = ["is-active", "--quiet", normalizedUnit];
  const res = scope === "system" ? await execSystemctl(args) : await execSystemctlUser(env, args);
  // is-active uses 3 for not-active and 4 for missing; query failures exit 1.
  if (res.termination === "exit" && [0, 3, 4].includes(res.code)) {
    return ok(res.code === 0);
  }
  return err(readSystemctlDetail(res) || `systemctl is-active exited with code ${res.code}`);
}

export async function assertSystemdAvailable(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  timeoutMs?: number,
) {
  const res = await execSystemctlUser(env, ["status"], timeoutMs);
  if (res.code === 0) {
    return;
  }
  const detail = readSystemctlDetail(res);
  if (isSystemctlMissing(res)) {
    throw systemdInspectionError(
      res,
      "systemctl not available; systemd user services are required on Linux.",
    );
  }
  if (res.termination === "exit" && detail && !isSystemdUserScopeUnavailable(detail)) {
    return;
  }
  throw systemdInspectionError(
    res,
    `systemctl --user unavailable: ${detail || "unknown error"}`.trim(),
  );
}

export async function isSystemctlAvailable(env: GatewayServiceEnv): Promise<boolean> {
  const res = await execSystemctl(["--version"], env);
  // Cleanup uses false to permit file-only removal. An interrupted executable probe
  // must still attempt disable before removing a potentially loaded unit.
  return res.code === 0 || !isSystemctlMissing(res);
}

/** Authenticate the existing unique manager owner before loading a bound unit.
 * The caller supplies its deadline- and custody-checked D-Bus query. */
export async function bindSystemdManagerOwner(
  query: (args: string[], signatures: string[]) => Promise<unknown[] | null>,
  managerUid: number,
  unavailable: () => Error,
): Promise<{ destination: string; verify: () => Promise<void> }> {
  const manager = "org.freedesktop.systemd1";
  const readOwner = async () => {
    const [value] =
      (await query(
        [
          "call",
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus",
          "GetNameOwner",
          "s",
          manager,
        ],
        ["s"],
      )) ?? [];
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      typeof value[0] !== "string" ||
      !/^:[0-9]+\.[0-9]+$/.test(value[0])
    ) {
      throw unavailable();
    }
    return value[0];
  };
  const destination = await readOwner();
  const [uid] =
    (await query(
      [
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetConnectionUnixUser",
        "s",
        destination,
      ],
      ["u"],
    )) ?? [];
  if (
    !Number.isInteger(managerUid) ||
    managerUid < 0 ||
    managerUid >= 0xffffffff ||
    !Array.isArray(uid) ||
    uid.length !== 1 ||
    uid[0] !== managerUid
  ) {
    throw unavailable();
  }
  return {
    destination,
    async verify() {
      if (destination !== (await readOwner())) {
        throw unavailable();
      }
    },
  };
}
