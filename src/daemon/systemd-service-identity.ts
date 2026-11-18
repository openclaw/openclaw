/** Capture and revalidate the native owner across a stopped-service repair. */
import os from "node:os";
import {
  withServiceInspectionBudget,
  runServiceInspectionGuard,
} from "./service-inspection-budget.js";
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
import {
  isSystemdManagerUid,
  readSystemdBusCall,
  readSystemdUnitObjectPath,
  systemdUnitCallArgs,
} from "./systemd-bus-query.js";
import { openSystemdBroker, openSystemdMachineBroker } from "./systemd-peer-native.js";
import { SYSTEMD_DEFAULT_STOP_TIMEOUT_MS } from "./systemd-time-span.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

export function assertSystemdServiceAccount(user: string) {
  const account = os.userInfo();
  if (
    user !== account.username &&
    user !== String(account.uid) &&
    !(user === "" && account.uid === 0)
  ) {
    throw new ServiceOwnershipRefusalError("systemd-account-refused");
  }
  return account;
}

const MANAGER = "org.freedesktop.systemd1";
const MANAGER_PATH = "/org/freedesktop/systemd1";
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
  rootServiceAccount?: string,
): Promise<SystemdServiceIdentity> {
  const call = (method: string, args: string[], signature: string) =>
    readSystemdBusCall(
      (queryArgs, signatures) => broker.query(queryArgs, signatures, deadline),
      method,
      args,
      signature,
      unavailable,
    );
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
  if (!isSystemdManagerUid(managerUid)) {
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
    systemdUnitCallArgs(managerOwner, target.unitName, expected ? "LoadUnit" : "GetUnit"),
    ["o"],
    deadline,
  );
  const unitPath = readSystemdUnitObjectPath(unit?.[0], unavailable);
  const definition = await broker.query(
    ["get-property", managerOwner, unitPath, `${MANAGER}.Unit`, "Id", "FragmentPath"],
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
    ["get-property", managerOwner, unitPath, `${MANAGER}.Service`, "User"],
    ["s"],
    deadline,
  );
  const serviceUser = service?.[0];
  if (typeof serviceUser !== "string") {
    throw unavailable();
  }
  const adoptedAccount = rootServiceAccount ?? expected?.rootServiceAccount;
  if (adoptedAccount !== undefined) {
    if (
      target.scope !== "system" ||
      process.geteuid?.() !== 0 ||
      !adoptedAccount ||
      adoptedAccount === "root" ||
      adoptedAccount === "0" ||
      serviceUser !== adoptedAccount
    ) {
      throw new ServiceOwnershipRefusalError("systemd-account-refused");
    }
  } else if (target.scope === "system") {
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
  return {
    ...target,
    bus,
    busId,
    managerOwner,
    managerUid,
    serviceUser,
    ...(adoptedAccount !== undefined ? { rootServiceAccount: adoptedAccount } : {}),
  };
}

export async function captureSystemdServiceIdentity(params: {
  env: GatewayServiceEnv;
  target: SystemdServiceReadTarget;
  managerUid?: number;
  /** Only an explicitly adopted root-owned installation may select another account. */
  rootServiceAccount?: string;
  timeoutMs?: number;
}): Promise<SystemdServiceIdentity> {
  return await withServiceInspectionBudget(async (budget) => {
    const deadline = budget.now() + (params.timeoutMs ?? SYSTEMD_DEFAULT_STOP_TIMEOUT_MS);
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
      const identity = await inspectIdentity(
        broker,
        params.target,
        bus,
        deadline,
        undefined,
        params.rootServiceAccount,
      );
      if (params.managerUid !== undefined && identity.managerUid !== params.managerUid) {
        throw new ServiceOwnershipRefusalError("systemd-manager-changed");
      }
      return identity;
    } finally {
      await broker.close();
    }
  });
}

export async function activateSystemdServiceIdentity(params: {
  identity: SystemdServiceIdentity;
  action: "start" | "stop" | "restart";
  assertCurrent?: () => void;
  beforeMutation?: () => Promise<void>;
  beforeEffect?: () => void;
  prepareEffect?: () => Promise<void>;
  warn: (message: string) => void;
}): Promise<void> {
  return await withServiceInspectionBudget(async (budget) => {
    let authorityFailure: { error: unknown } | undefined;
    const assertCurrent = () => {
      try {
        assertGatewayServiceUpdateCurrent();
        runServiceInspectionGuard(params.assertCurrent);
      } catch (error) {
        authorityFailure = { error };
        throw error;
      }
    };
    assertCurrent();
    const { identity } = params;
    const deadline = budget.now() + SYSTEMD_DEFAULT_STOP_TIMEOUT_MS;
    const broker = await openBroker(identity.bus, deadline);
    try {
      const methods =
        params.action === "stop"
          ? ["StopUnit"]
          : ["ResetFailedUnit", params.action === "start" ? "StartUnit" : "RestartUnit"];
      for (const method of methods) {
        await params.beforeMutation?.();
        assertCurrent();
        await inspectIdentity(broker, identity, identity.bus, deadline, identity);
        assertCurrent();
        await params.prepareEffect?.();
        assertCurrent();
        const reset = method === "ResetFailedUnit";
        let effectFailure: { error: unknown } | undefined;
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
            () => {
              try {
                params.beforeEffect?.();
              } catch (error) {
                effectFailure = { error };
                throw error;
              }
            },
            SYSTEMD_DEFAULT_STOP_TIMEOUT_MS,
          );
        } catch (error) {
          if (authorityFailure) {
            throw authorityFailure.error;
          }
          if (effectFailure) {
            throw effectFailure.error;
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
  });
}
