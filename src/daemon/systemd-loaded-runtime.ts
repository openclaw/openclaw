// Admission reads already-loaded state. Recovery may load a bound definition
// under live custody; neither mode starts a unit or a bus service.
import { isDeepStrictEqual } from "node:util";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "./service-inspection-error.js";
import {
  createServiceRuntimeInspectionFailure,
  resolveSystemdServiceStartRefusal,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import type {
  GatewayServiceEnv,
  GatewayServiceUnitInspection,
  SystemdServiceReadBinding,
  SystemdServiceReadTarget,
} from "./service-types.js";
import {
  decodeSystemdBusProperties,
  isSystemdManagerUid,
  readSystemdBusCall,
  readSystemdBusOwner,
  readSystemdUnitObjectPath,
  systemdUnitCallArgs,
} from "./systemd-bus-query.js";
import { execBusctlSystem, execBusctlUser, systemdInspectionError } from "./systemd-exec.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";
import { readSystemdUserTransport } from "./systemd-user-transport.js";

const MANAGER = "org.freedesktop.systemd1";
const isUint32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const isInt32 = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= -0x80000000 &&
  value <= 0x7fffffff;
const optionalCounter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** The selected manager must retain the same loaded unit throughout inspection. */
export async function readLoadedSystemdServiceRuntime(
  env: GatewayServiceEnv,
  timeoutMs?: number,
  inspection?: GatewayServiceUnitInspection,
  binding?: SystemdServiceReadBinding,
  target?: SystemdServiceReadTarget,
): Promise<GatewayServiceRuntime> {
  const unitName = target?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  const scope = target?.scope ?? "user";
  const budget =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  const deadline = performance.now() + budget;
  let remainingQueries = 7;
  const unavailable = () =>
    new Error("Loaded systemd runtime could not be inspected without activation.");
  const query = async (args: string[], signatures: string[]): Promise<unknown[]> => {
    const assertCurrent =
      args[0] === "call" && args[4] === "LoadUnit"
        ? inspection?.assertCurrent
        : (inspection?.assertReadCurrent ?? inspection?.assertCurrent);
    assertCurrent?.();
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    if (remainingQueries <= 0) {
      throw unavailable();
    }
    if (binding) {
      if (scope === "system" || binding.unit !== unitName) {
        throw new ServiceOwnershipRefusalError("systemd-manager-changed");
      }
      remainingQueries--;
      const values = await binding.query(args, signatures, deadline, inspection);
      if (!values) {
        throw unavailable();
      }
      assertCurrent?.();
      if (performance.now() >= deadline) {
        throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
      }
      return values;
    }
    const queryArgs = ["--auto-start=no", "--json=short", ...args];
    const callTimeout = Math.max(1, Math.floor(remaining / remainingQueries--));
    const result =
      scope === "system"
        ? await execBusctlSystem(queryArgs, callTimeout)
        : await execBusctlUser(env, queryArgs, callTimeout, assertCurrent);
    assertCurrent?.();
    if (performance.now() >= deadline) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    if (result.code !== 0 || result.termination !== "exit") {
      throw systemdInspectionError(result, unavailable().message, scope);
    }
    return decodeSystemdBusProperties(result.stdout, signatures, unavailable);
  };
  const readOwner = async () => {
    if (binding) {
      binding.verify();
      return binding.destination;
    }
    return readSystemdBusOwner(query, unavailable);
  };
  try {
    // Address every unit query to the observed unique bus owner, never a newly started manager.
    const owner = await readOwner();
    const managerUid = binding
      ? binding.managerUid
      : await readSystemdBusCall(query, "GetConnectionUnixUser", ["s", owner], "u", unavailable);
    if (!isSystemdManagerUid(managerUid)) {
      throw unavailable();
    }
    if (
      (scope === "system" && managerUid !== 0) ||
      (inspection && managerUid !== inspection.managerUid)
    ) {
      throw new ServiceOwnershipRefusalError("systemd-manager-changed");
    }
    const [unit] = await query(
      systemdUnitCallArgs(owner, unitName, inspection ? "LoadUnit" : "GetUnit"),
      ["o"],
    );
    const unitPath = readSystemdUnitObjectPath(unit, unavailable);
    const readUnit = () =>
      query(
        [
          "get-property",
          owner,
          unitPath,
          `${MANAGER}.Unit`,
          "Id",
          "LoadState",
          "ActiveState",
          "SubState",
          "StartLimitBurst",
          "ActiveEnterTimestampMonotonic",
          "InactiveEnterTimestampMonotonic",
          "UnitFileState",
          "RefuseManualStart",
          "CanStart",
        ],
        ["s", "s", "s", "s", "u", "t", "t", "s", "b", "b"],
      );
    const before = await readUnit();
    const [
      id,
      load,
      active,
      sub,
      burst,
      entered,
      left,
      unitFileState,
      refuseManualStart,
      canStart,
    ] = before;
    const startRefusal = resolveSystemdServiceStartRefusal({
      unit: unitName,
      scope,
      loadState: typeof load === "string" ? load : undefined,
      unitFileState: typeof unitFileState === "string" ? unitFileState : undefined,
      activeState: typeof active === "string" ? active : undefined,
      refuseManualStart: refuseManualStart === true,
      canStart: typeof canStart === "boolean" ? canStart : undefined,
    });
    if (
      load === "masked" &&
      id === unitName &&
      isDeepStrictEqual(before, await readUnit()) &&
      owner === (await readOwner())
    ) {
      return {
        status: "unknown",
        detail: startRefusal?.message,
        systemd: { scope, unit: unitName, startRefusal },
      };
    }
    const [result, restarts, pid, exitStatus, exitCode, killMode, tasks, memory, controlGroup] =
      await query(
        [
          "get-property",
          owner,
          unitPath,
          `${MANAGER}.Service`,
          "Result",
          "NRestarts",
          "MainPID",
          "ExecMainStatus",
          "ExecMainCode",
          "KillMode",
          "TasksCurrent",
          "MemoryCurrent",
          "ControlGroup",
        ],
        ["s", "u", "u", "i", "i", "s", "t", "t", "s"],
      );
    let drained = optionalCounter(tasks) === 0;
    if (
      (active === "inactive" || active === "failed") &&
      pid === 0 &&
      optionalCounter(tasks) === undefined
    ) {
      // TasksCurrent is UINT64_MAX when accounting is unavailable, not zero.
      // Ask the pinned manager for descendants and main/control PIDs instead.
      // Admission never loads. Owned inspection uses the unit-object method so
      // collection between queries can reload a definition, never start a process.
      // GetProcesses belongs to the Service cgroup interface, not Unit.
      // Any failed or nonempty enumeration remains unknown.
      remainingQueries++;
      const [processes] = await query(
        inspection
          ? ["call", owner, unitPath, `${MANAGER}.Service`, "GetProcesses"]
          : systemdUnitCallArgs(owner, unitName, "GetUnitProcesses"),
        ["a(sus)"],
      );
      drained =
        Array.isArray(processes) &&
        processes.length === 1 &&
        Array.isArray(processes[0]) &&
        processes[0].length === 0;
    }
    // Same manager identity alone does not exclude unit restart/state changes.
    // Compare native transition generations as well as state to reject ABA observations.
    const after = await readUnit();
    if (owner !== (await readOwner())) {
      throw new ServiceOwnershipRefusalError("systemd-manager-changed");
    }
    if (
      !isDeepStrictEqual(before, after) ||
      optionalCounter(entered) === undefined ||
      optionalCounter(left) === undefined ||
      id !== unitName ||
      load !== "loaded" ||
      typeof active !== "string" ||
      typeof sub !== "string" ||
      !isUint32(burst) ||
      typeof result !== "string" ||
      !isUint32(restarts) ||
      !isUint32(pid) ||
      !isInt32(exitStatus) ||
      !isInt32(exitCode) ||
      typeof controlGroup !== "string" ||
      typeof killMode !== "string"
    ) {
      throw unavailable();
    }
    return {
      status:
        active === "active"
          ? "running"
          : (active === "inactive" || active === "failed") && pid === 0 && drained
            ? "stopped"
            : "unknown",
      ...(startRefusal ? { detail: startRefusal.message } : {}),
      state: active,
      subState: sub,
      pid: pid > 0 ? pid : undefined,
      lastExitStatus: exitStatus,
      lastExitReason: [undefined, "exited", "killed", "dumped", "trapped", "stopped", "continued"][
        exitCode
      ],
      systemd: {
        scope,
        ...(scope === "user" ? { transport: await readSystemdUserTransport(env) } : {}),
        unit: id,
        ...(startRefusal ? { startRefusal } : {}),
        managerUid,
        result,
        nRestarts: restarts,
        startLimitBurst: burst,
        controlGroup: controlGroup || undefined,
        killMode,
        tasksCurrent: optionalCounter(tasks),
        memoryCurrent: optionalCounter(memory),
      },
    };
  } catch (error) {
    return createServiceRuntimeInspectionFailure(error);
  }
}
