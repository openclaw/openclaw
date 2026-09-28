import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { execFileUtf8 } from "./exec-file.js";
import {
  findServiceOwnershipRefusal,
  ServiceInspectionError,
  type ServiceInspectionReason,
} from "./service-inspection-error.js";
import type { SystemdUserTransport } from "./service-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { decodeLegacyBusctlOutput } from "./systemd-busctl-legacy.js";
import { openSystemdUserManager } from "./systemd-peer-native.js";
import { resolveUnavailableSystemdInspectionReason } from "./systemd-unavailable.js";

// Reachability is a process-local routing fact, never a connection or mutation grant.
type Selection = { transport: SystemdUserTransport; timedOut: boolean };
const transports = new Map<string, Promise<Selection>>();
const manager = "org.freedesktop.systemd1";
const versionArgs = [
  "get-property",
  manager,
  "/org/freedesktop/systemd1",
  `${manager}.Manager`,
  "Version",
];
export const SYSTEMD_TRANSPORT_DEADLINE = new ServiceInspectionError(
  "systemd-inspection-deadline-exceeded",
);
const addressFor = (socket: string) =>
  `unix:path=${encodeURIComponent(socket).replaceAll("%2F", "/")}`;
const transportKey = (env: GatewayServiceEnv, uid = process.geteuid?.()) => {
  const source = { ...process.env, ...env };
  return JSON.stringify([
    uid,
    source.USER,
    source.LOGNAME,
    source.SUDO_USER,
    source.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`,
    source.DBUS_SESSION_BUS_ADDRESS?.trim(),
  ]);
};

/** Presentation consumes the recorded route without creating another probe. */
export async function readSystemdUserTransport(env: GatewayServiceEnv) {
  return (await transports.get(transportKey(env))?.catch(() => undefined))?.transport;
}

export async function resolveSystemdUserTransport(
  env: GatewayServiceEnv,
  deadline = performance.now() + 5000,
  assertCurrent?: () => void,
  purpose: "inspection" | "admission" = "inspection",
): Promise<SystemdUserTransport | undefined> {
  const check = () => {
    assertGatewayServiceUpdateCurrent();
    assertCurrent?.();
    if (performance.now() >= deadline) {
      throw SYSTEMD_TRANSPORT_DEADLINE;
    }
  };
  const uid = process.geteuid?.();
  const { machineUser, preferMachineScope } = resolveSystemctlUserScope(env);
  if (preferMachineScope && machineUser) {
    return { kind: "machine", user: machineUser };
  }
  if (process.platform !== "linux" || uid === undefined) {
    return undefined;
  }
  check();
  const source = { ...process.env, ...env };
  const runtimeDir = source.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`;
  const explicit = source.DBUS_SESSION_BUS_ADDRESS?.trim();
  const key = transportKey(source, uid);
  let pending = transports.get(key);
  const joined = pending !== undefined;
  if (!pending) {
    pending = select();
    transports.set(key, pending);
    void pending.catch(() => {
      if (transports.get(key) === pending) {
        transports.delete(key);
      }
    });
  }
  const discovery = pending;
  let selected: Selection | typeof ABSOLUTE_DEADLINE_EXPIRED;
  try {
    selected = await awaitWithinDeadline(
      () => discovery,
      deadline,
      () => performance.now(),
    );
  } catch (error) {
    check();
    const refusal = findServiceOwnershipRefusal(error);
    if (refusal) {
      throw refusal;
    }
    // A failed shared discovery does not consume this caller's independent custody/budget.
    if (joined) {
      return await resolveSystemdUserTransport(env, deadline, assertCurrent, purpose);
    }
    throw error;
  }
  check();
  if (selected === ABSOLUTE_DEADLINE_EXPIRED) {
    throw SYSTEMD_TRANSPORT_DEADLINE;
  }
  // A timed-out earlier candidate remains unresolved for a later admission.
  if (joined && purpose === "admission" && selected.timedOut) {
    if (transports.get(key) === discovery) {
      transports.delete(key);
    }
    return await resolveSystemdUserTransport(env, deadline, assertCurrent, purpose);
  }
  return selected.transport;

  async function select(): Promise<Selection> {
    const runtimeAddress = addressFor(path.posix.join(runtimeDir, "bus"));
    const socket = path.posix.join(runtimeDir, "systemd/private");
    const candidates: SystemdUserTransport[] = [
      ...(explicit ? [{ kind: "session-bus" as const, address: explicit, runtimeDir }] : []),
      ...(explicit !== runtimeAddress && fs.existsSync(path.posix.join(runtimeDir, "bus"))
        ? [{ kind: "runtime-bus" as const, address: runtimeAddress, runtimeDir }]
        : []),
      ...(path.posix.isAbsolute(socket) && fs.existsSync(socket)
        ? [{ kind: "private" as const, address: addressFor(socket), runtimeDir }]
        : []),
      ...(machineUser ? [{ kind: "machine" as const, user: machineUser }] : []),
    ];
    let reason: ServiceInspectionReason = "systemd-user-bus-unavailable";
    let timedOut = false;
    for (const [index, candidate] of candidates.entries()) {
      check();
      const budget = Math.max(
        1,
        Math.floor((deadline - performance.now()) / (candidates.length - index + 1)),
      );
      const until = performance.now() + budget;
      let connection: Awaited<ReturnType<typeof openSystemdUserManager>> | undefined;
      try {
        let version: unknown;
        if (candidate.kind === "private") {
          connection = await openSystemdUserManager(candidate.address, until);
          check();
          [version] = (await connection.query(versionArgs, ["s"], until)) ?? [];
        } else {
          const scope =
            candidate.kind === "machine"
              ? ["--machine", `${candidate.user}@`, "--user"]
              : ["--user"];
          const result = await execFileUtf8(
            "busctl",
            [...scope, "--auto-start=no", ...versionArgs],
            {
              env:
                candidate.kind === "machine"
                  ? source
                  : { ...source, DBUS_SESSION_BUS_ADDRESS: candidate.address },
              timeout: budget,
              killSignal: "SIGKILL",
            },
          );
          check();
          if (result.termination === "timeout" || result.termination === "no-output-timeout") {
            timedOut = true;
          }
          if (result.termination === "exit" && result.code === 0) {
            [version] = decodeLegacyBusctlOutput(result.stdout, ["s"], false);
          }
          if (result.errorCode === "ENOENT") {
            reason = "systemd-busctl-unavailable";
          } else if (["EACCES", "EPERM"].includes(result.errorCode ?? "")) {
            reason = "service-manager-access-denied";
          }
        }
        check();
        if (typeof version === "string" && version.length > 0) {
          return { transport: candidate, timedOut };
        }
      } catch (error) {
        check();
        const refusal = findServiceOwnershipRefusal(error);
        if (refusal) {
          throw refusal;
        }
        if (error === SYSTEMD_TRANSPORT_DEADLINE) {
          throw error;
        }
        timedOut ||= performance.now() >= until;
      } finally {
        await connection?.close();
      }
    }
    check();
    if (!timedOut && reason !== "service-manager-access-denied") {
      reason = await resolveUnavailableSystemdInspectionReason(reason, source, deadline);
      check();
    }
    throw timedOut ? SYSTEMD_TRANSPORT_DEADLINE : new ServiceInspectionError(reason);
  }
}

function readSystemctlEffectiveUser(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

function isNonRootUser(user: string | null): user is string {
  return Boolean(user && user !== "root");
}

function resolveSystemctlUserScope(env: GatewayServiceEnv): {
  machineUser: string | null;
  preferMachineScope: boolean;
} {
  const sudoUser = env.SUDO_USER?.trim() || null;
  const envUser = env.USER?.trim() || env.LOGNAME?.trim() || null;
  const effectiveUid = process.geteuid?.();
  const effectiveUser = readSystemctlEffectiveUser();
  const isEffectiveRoot =
    effectiveUid === undefined ? effectiveUser === "root" : effectiveUid === 0;
  const hasRootUserManager =
    isEffectiveRoot &&
    env.HOME?.trim() === "/root" &&
    env.XDG_RUNTIME_DIR?.trim() === "/run/user/0" &&
    Boolean(env.DBUS_SESSION_BUS_ADDRESS?.includes("/run/user/0/bus"));
  const isSudoToRoot = isEffectiveRoot && !hasRootUserManager && isNonRootUser(sudoUser);
  const machineUser = hasRootUserManager
    ? null
    : isSudoToRoot
      ? sudoUser
      : isNonRootUser(envUser)
        ? envUser
        : isNonRootUser(sudoUser)
          ? sudoUser
          : effectiveUser || envUser || sudoUser || null;
  return {
    machineUser,
    preferMachineScope: isSudoToRoot,
  };
}

/** True when root-owned paths would be paired with the sudo caller's user manager. */
export function hasSudoToRootSystemdUserManagerMismatch(env: GatewayServiceEnv): boolean {
  return resolveSystemctlUserScope(env).preferMachineScope;
}

/**
 * Resolves the account whose user manager owns the service operation.
 * Keep linger diagnostics on this identity so sudo never checks root while
 * systemctl targets the invoking user's manager.
 */
export function resolveSystemdUserServiceAccount(env: GatewayServiceEnv): string | null {
  const { machineUser } = resolveSystemctlUserScope(env);
  return (
    machineUser ?? readSystemctlEffectiveUser() ?? env.USER?.trim() ?? env.LOGNAME?.trim() ?? null
  );
}
