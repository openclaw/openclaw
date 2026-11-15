/** Read loaded service commands without loading units or reading their environment files. */
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { pathEntryExists } from "../infra/path-existence.js";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { withServiceInspectionBudget } from "./service-inspection-budget.js";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
  SystemdInspectionTimeout,
} from "./service-inspection-error.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import {
  readSystemdUnitObjectPath,
  readSystemdBusCall,
  systemdUnitCallArgs,
  type SystemdBusQuery,
} from "./systemd-bus-query.js";
import { createSystemdBusctlQuery } from "./systemd-busctl-query.js";
import {
  bindSystemdManagerOwner,
  execSystemctl,
  execSystemctlUser,
  isRunningAsRoot,
} from "./systemd-exec.js";
import {
  openSystemdBroker,
  openSystemdMachineBroker,
  openSystemdPrivatePeer,
  openSystemdUserManager,
} from "./systemd-peer-native.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

const INSPECTION_TIMEOUT_MS = 15_000;

export type LoadedSystemdUnit = {
  name: string;
  fragmentPath: string;
  commands: { path: string; programArguments: string[] }[];
};

export async function hasSystemdManager(
  scope: "user" | "system",
  env: GatewayServiceEnv,
): Promise<boolean> {
  if (scope === "system") {
    return Boolean(env.DBUS_SYSTEM_BUS_ADDRESS) || (await pathEntryExists("/run/systemd/system"));
  }
  if (env.DBUS_SESSION_BUS_ADDRESS || env.SUDO_USER) {
    return true;
  }
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.geteuid?.()}`;
  return (
    path.isAbsolute(runtimeDir) &&
    ((await pathEntryExists(path.join(runtimeDir, "systemd/private"))) ||
      (await pathEntryExists(path.join(runtimeDir, "bus"))))
  );
}

const unavailable = () => new Error("Loaded systemd service properties could not be inspected.");

export async function listLoadedSystemdUnits(
  scope: "user" | "system",
  env: GatewayServiceEnv,
): Promise<LoadedSystemdUnit[]> {
  if (!(await hasSystemdManager(scope, env))) {
    return [];
  }
  return await withServiceInspectionBudget(async (budget) => {
    let deadline = budget.now() + INSPECTION_TIMEOUT_MS;
    const transport =
      scope === "user"
        ? await resolveSystemdUserTransport(env, deadline, undefined, "inspection")
        : undefined;
    if (scope === "user" && !transport) {
      throw new ServiceInspectionError("systemd-user-bus-unavailable");
    }
    const mode = process.env.PROC_SAFE_NATIVE ?? "auto";
    // Match systemctl's local root route, including its explicit broker override.
    const systemPrivate =
      scope === "system" &&
      isRunningAsRoot() &&
      !/^(?:1|yes|y|true|t|on)$/i.test(process.env.SYSTEMCTL_FORCE_BUS ?? "");
    let connection: Awaited<ReturnType<typeof openSystemdBroker>> | undefined;
    if (mode !== "off") {
      try {
        if (systemPrivate) {
          const startTime = getProcessStartTime(1);
          if (startTime === null) {
            throw unavailable();
          }
          connection = await openSystemdPrivatePeer(
            "unix:path=/run/systemd/private",
            { uid: 0, pid: 1, startTime },
            deadline,
          );
        } else {
          connection =
            transport?.kind === "private"
              ? await openSystemdUserManager(transport.address, deadline)
              : transport?.kind === "machine"
                ? await openSystemdMachineBroker(`${transport.user}@`, deadline)
                : await openSystemdBroker(
                    transport?.address ??
                      process.env.DBUS_SYSTEM_BUS_ADDRESS ??
                      "unix:path=/run/dbus/system_bus_socket",
                    deadline,
                  );
        }
      } catch (error) {
        // Shipped CLI inspection remains available when optional native support is absent.
        // Connection, authority, timeout and decoding failures are not fallback signals.
        if (
          mode !== "auto" ||
          !(error instanceof ProcSafeError) ||
          error.code !== "helper-unavailable"
        ) {
          throw error;
        }
      }
    }
    if (!connection && (systemPrivate || transport?.kind === "private")) {
      // A broker can select another manager; it cannot substitute for a selected private peer.
      if (systemPrivate) {
        throw Object.assign(new ServiceInspectionError(undefined), {
          message: "The selected systemd private manager requires native inspection support.",
        });
      }
      throw new ServiceInspectionError("systemd-user-bus-unavailable");
    }
    const units: LoadedSystemdUnit[] = [];
    let failure: { error: unknown } | undefined;
    try {
      const nativeConnection = connection;
      const createQuery = (calls: number): SystemdBusQuery =>
        nativeConnection
          ? (args, signatures) => nativeConnection.query(args, signatures, deadline)
          : createSystemdBusctlQuery({
              env,
              scope,
              deadline,
              calls,
              boundCalls: true,
              noAutoStart: true,
              unavailable,
              assertCurrent: () => assertGatewayServiceUpdateCurrent,
            });
      let phaseQuery = createQuery(3);
      const query: SystemdBusQuery = (args, signatures) => phaseQuery(args, signatures);
      const readBusId = () => readSystemdBusCall(query, "GetId", [], "s", unavailable);
      const busId = connection ? undefined : await readBusId();
      if (!connection && (typeof busId !== "string" || !busId)) {
        throw unavailable();
      }
      const manager = "org.freedesktop.systemd1";
      const binding =
        connection && (systemPrivate || transport?.kind === "private")
          ? undefined
          : await bindSystemdManagerOwner(query, scope === "system" ? 0 : undefined, unavailable);
      const destination = binding?.destination ?? manager;
      const args = [
        "list-units",
        "--all",
        "--type=service",
        "--state=active,activating,reloading,deactivating,failed",
        "--plain",
        "--no-legend",
        "--no-pager",
        "--full",
      ];
      const remaining = deadline - budget.now();
      if (remaining <= 0) {
        throw new SystemdInspectionTimeout(`systemctl --${scope} list-units`);
      }
      const listed =
        scope === "user"
          ? await execSystemctlUser(env, args, remaining)
          : await execSystemctl(["--system", ...args], undefined, remaining);
      if (budget.now() >= deadline) {
        throw new SystemdInspectionTimeout(`systemctl --${scope} list-units`);
      }
      if (listed.termination !== "exit" || listed.code !== 0) {
        throw new Error("Loaded systemd service list could not be inspected.");
      }
      const parsedNames: string[] = [];
      for (const line of listed.stdout.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const name = line.trimStart().split(/\s+/, 1)[0];
        if (!name?.endsWith(".service")) {
          throw new Error("Loaded systemd service list could not be inspected.");
        }
        parsedNames.push(name);
      }
      const names = [...new Set(parsedNames)];
      // Preserve the two bounded phases, but carry the original manager through both.
      deadline = budget.now() + INSPECTION_TIMEOUT_MS;
      phaseQuery = createQuery(names.length * 3 + (connection ? 1 : 2));
      for (const name of names) {
        const unit = await query(systemdUnitCallArgs(destination, name, "GetUnit"), ["o"]);
        const unitPath = readSystemdUnitObjectPath(unit?.[0], unavailable);
        const definition = await query(
          [
            "get-property",
            destination,
            unitPath,
            `${manager}.Unit`,
            "Id",
            "FragmentPath",
            "ActiveState",
          ],
          ["s", "s", "s"],
        );
        if (
          definition?.[0] !== name ||
          typeof definition[1] !== "string" ||
          typeof definition[2] !== "string" ||
          !definition[2]
        ) {
          throw unavailable();
        }
        const executions = (
          await query(
            ["get-property", destination, unitPath, `${manager}.Service`, "ExecStart"],
            ["a(sasbttttuii)"],
          )
        )?.[0];
        if (!Array.isArray(executions)) {
          throw unavailable();
        }
        const commands = executions.map((execution: unknown) => {
          if (
            !Array.isArray(execution) ||
            execution.length !== 10 ||
            typeof execution[0] !== "string" ||
            !execution[0] ||
            !Array.isArray(execution[1]) ||
            execution[1].length === 0 ||
            !execution[1].every((arg: unknown) => typeof arg === "string")
          ) {
            throw unavailable();
          }
          return { path: execution[0], programArguments: execution[1] };
        });
        if (
          ["active", "activating", "reloading", "deactivating", "failed"].includes(definition[2])
        ) {
          units.push({ name, fragmentPath: definition[1], commands });
        }
      }
      await binding?.verify();
      if (!connection && (await readBusId()) !== busId) {
        throw new ServiceOwnershipRefusalError("systemd-manager-changed");
      }
      connection?.verify();
    } catch (error) {
      failure = { error };
    }
    try {
      await connection?.close();
    } catch (error) {
      if (failure) {
        throw new AggregateError(
          [failure.error, error],
          "Systemd inventory inspection and cleanup failed.",
          { cause: error },
        );
      }
      throw error;
    }
    if (failure) {
      throw failure.error;
    }
    if (budget.now() >= deadline) {
      throw new SystemdInspectionTimeout("loaded unit inventory cleanup");
    }
    return units;
  });
}
