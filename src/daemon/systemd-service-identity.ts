/** Capture and revalidate the native owner across a stopped-service repair. */
import {
  findServiceOwnershipRefusal,
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "./service-inspection-error.js";
import type {
  GatewayServiceEnv,
  SystemdServiceIdentity,
  SystemdServiceReadTarget,
} from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { openSystemdBroker, openSystemdMachineBroker } from "./systemd-peer-native.js";
import { assertSystemdServiceAccount } from "./systemd-service-files.js";
import { SYSTEMD_DEFAULT_STOP_TIMEOUT_MS } from "./systemd-time-span.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

const MANAGER = "org.freedesktop.systemd1";
const MANAGER_PATH = "/org/freedesktop/systemd1";
const BUS = "org.freedesktop.DBus";
const unavailable = () =>
  new Error("The systemd service activation identity could not be inspected.");

function openBroker(bus: SystemdServiceIdentity["bus"], deadline: number) {
  return "address" in bus
    ? openSystemdBroker(bus.address, deadline)
    : openSystemdMachineBroker(bus.machine, deadline);
}

type Broker = Awaited<ReturnType<typeof openSystemdBroker>>;

async function inspectIdentity(
  broker: Broker,
  target: Pick<SystemdServiceReadTarget, "scope" | "unitName" | "unitPath">,
  bus: SystemdServiceIdentity["bus"],
  deadline: number,
  expected?: SystemdServiceIdentity,
): Promise<SystemdServiceIdentity> {
  const call = async (method: string, args: string[], signature: string) => {
    const reply = await broker.query(
      ["call", BUS, "/org/freedesktop/DBus", BUS, method, ...args],
      [signature],
      deadline,
    );
    const value = reply?.[0];
    if (!Array.isArray(value) || value.length !== 1) {
      throw unavailable();
    }
    const result: unknown = value[0];
    return result;
  };
  const busId = await call("GetId", [], "s");
  const managerOwner = await call("GetNameOwner", ["s", MANAGER], "s");
  if (
    typeof busId !== "string" ||
    !/^[a-f0-9]{32}$/i.test(busId) ||
    typeof managerOwner !== "string" ||
    !/^:[0-9]+\.[0-9]+$/.test(managerOwner)
  ) {
    throw unavailable();
  }
  const managerUid = await call("GetConnectionUnixUser", ["s", managerOwner], "u");
  if (
    typeof managerUid !== "number" ||
    !Number.isInteger(managerUid) ||
    managerUid < 0 ||
    managerUid >= 0xffffffff
  ) {
    throw unavailable();
  }
  if (
    (target.scope === "system" && managerUid !== 0) ||
    (expected &&
      (busId !== expected.busId ||
        managerOwner !== expected.managerOwner ||
        managerUid !== expected.managerUid))
  ) {
    throw new ServiceOwnershipRefusalError("systemd-manager-changed");
  }
  const unit = await broker.query(
    [
      "call",
      managerOwner,
      MANAGER_PATH,
      `${MANAGER}.Manager`,
      expected ? "LoadUnit" : "GetUnit",
      "s",
      target.unitName,
    ],
    ["o"],
    deadline,
  );
  const unitPath = unit?.[0];
  if (
    !Array.isArray(unitPath) ||
    unitPath.length !== 1 ||
    typeof unitPath[0] !== "string" ||
    !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(unitPath[0])
  ) {
    throw unavailable();
  }
  const definition = await broker.query(
    ["get-property", managerOwner, unitPath[0], `${MANAGER}.Unit`, "Id", "FragmentPath"],
    ["s", "s"],
    deadline,
  );
  if (typeof definition?.[0] !== "string" || typeof definition?.[1] !== "string") {
    throw unavailable();
  }
  if (definition?.[0] !== target.unitName || definition?.[1] !== target.unitPath) {
    throw new ServiceOwnershipRefusalError("systemd-unit-changed");
  }
  const service = await broker.query(
    ["get-property", managerOwner, unitPath[0], `${MANAGER}.Service`, "User"],
    ["s"],
    deadline,
  );
  const serviceUser = service?.[0];
  if (typeof serviceUser !== "string") {
    throw unavailable();
  }
  if (target.scope === "system") {
    assertSystemdServiceAccount(serviceUser);
    // The account assertion normalizes root/name/UID aliases against this process.
    if (expected) {
      assertSystemdServiceAccount(expected.serviceUser);
    }
  } else if (expected && serviceUser !== expected.serviceUser) {
    throw new ServiceOwnershipRefusalError("systemd-account-refused");
  }
  if (managerOwner !== (await call("GetNameOwner", ["s", MANAGER], "s"))) {
    throw new ServiceOwnershipRefusalError("systemd-manager-changed");
  }
  return { ...target, bus, busId, managerOwner, managerUid, serviceUser };
}

export async function captureSystemdServiceIdentity(params: {
  env: GatewayServiceEnv;
  target: SystemdServiceReadTarget;
  managerUid?: number;
  timeoutMs?: number;
}): Promise<SystemdServiceIdentity> {
  const deadline = performance.now() + (params.timeoutMs ?? SYSTEMD_DEFAULT_STOP_TIMEOUT_MS);
  const transport =
    params.target.scope === "user"
      ? await resolveSystemdUserTransport(params.env, deadline, undefined, "admission")
      : undefined;
  if (params.target.scope === "user" && (!transport || transport.kind === "private")) {
    throw new ServiceInspectionError("systemd-user-bus-unavailable");
  }
  const bus: SystemdServiceIdentity["bus"] =
    transport?.kind === "machine"
      ? { machine: `${transport.user}@` }
      : {
          address:
            transport?.address ??
            process.env.DBUS_SYSTEM_BUS_ADDRESS ??
            "unix:path=/run/dbus/system_bus_socket",
        };
  const broker = await openBroker(bus, deadline);
  try {
    const identity = await inspectIdentity(broker, params.target, bus, deadline);
    if (params.managerUid !== undefined && identity.managerUid !== params.managerUid) {
      throw new ServiceOwnershipRefusalError("systemd-manager-changed");
    }
    return identity;
  } finally {
    await broker.close();
  }
}

export async function activateSystemdServiceIdentity(params: {
  identity: SystemdServiceIdentity;
  action: "start" | "restart";
  assertCurrent?: () => void;
  warn: (message: string) => void;
}): Promise<void> {
  let authorityFailure: { error: unknown } | undefined;
  const assertCurrent = () => {
    try {
      assertGatewayServiceUpdateCurrent();
      params.assertCurrent?.();
    } catch (error) {
      authorityFailure = { error };
      throw error;
    }
  };
  assertCurrent();
  const { identity } = params;
  const deadline = performance.now() + SYSTEMD_DEFAULT_STOP_TIMEOUT_MS;
  const broker = await openBroker(identity.bus, deadline);
  try {
    for (const method of [
      "ResetFailedUnit",
      params.action === "start" ? "StartUnit" : "RestartUnit",
    ]) {
      await inspectIdentity(broker, identity, identity.bus, deadline, identity);
      assertCurrent();
      const reset = method === "ResetFailedUnit";
      try {
        await broker.query(
          [
            "call",
            identity.managerOwner,
            MANAGER_PATH,
            `${MANAGER}.Manager`,
            method,
            reset ? "s" : "ss",
            identity.unitName,
            ...(reset ? [] : ["replace"]),
          ],
          reset ? [] : ["o"],
          deadline,
          assertCurrent,
        );
      } catch (error) {
        if (authorityFailure) {
          throw authorityFailure.error;
        }
        assertCurrent();
        const refusal = findServiceOwnershipRefusal(error);
        if (refusal || !reset) {
          throw refusal ?? error;
        }
        params.warn(
          "systemd reset-failed did not complete; revalidating ownership and continuing with activation.",
        );
      }
    }
  } finally {
    await broker.close();
  }
}
