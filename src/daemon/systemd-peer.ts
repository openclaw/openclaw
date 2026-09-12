/** Admit only the private peer belonging to the originally selected broker manager. */
import path from "node:path";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import type { GatewayServiceEnv, SystemdServiceReadBinding } from "./service-types.js";
import { openSystemdBroker, openSystemdPrivatePeer } from "./systemd-peer-native.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

const MANAGER = "org.freedesktop.systemd1";
const BUS = "org.freedesktop.DBus";
const unavailable = () => new Error("Original systemd manager binding is unavailable or changed.");

// This optional local-PID admission must never execute a transport helper,
// resolve a remote hostname or enter another PID namespace. Legacy adapters
// retain their authored transport support when this narrow admission declines.
function isLocalUnixAddress(address: string): boolean {
  try {
    return address.split(";").every((entry) => {
      if (!entry.startsWith("unix:")) {
        return false;
      }
      const fields = new Map<string, string>();
      for (const item of entry.slice(5).split(",")) {
        const split = item.indexOf("=");
        if (split < 1) {
          return false;
        }
        const key = item.slice(0, split);
        const value = decodeURIComponent(item.slice(split + 1));
        if (
          !["path", "abstract", "guid"].includes(key) ||
          fields.has(key) ||
          !value ||
          value.includes("\0")
        ) {
          return false;
        }
        fields.set(key, value);
      }
      const pathname = fields.get("path"),
        abstract = fields.get("abstract"),
        guid = fields.get("guid");
      return Boolean(
        (pathname ? path.isAbsolute(pathname) && !abstract : abstract) &&
        (!guid || /^[a-f0-9]{32}$/i.test(guid)),
      );
    });
  } catch {
    return false;
  }
}

export async function admitSystemdServiceReadBinding(
  env: GatewayServiceEnv,
  deadline: number,
): Promise<SystemdServiceReadBinding | undefined> {
  // Capture ambient selectors once; neither subsequent env mutation nor the
  // legacy machine fallback may change the broker authenticated here.
  const route = { ...process.env, ...env };
  const uid = process.geteuid?.();
  // Do not alter root/sudo, remote, or system-manager selection. Existing native
  // adapters remain responsible when no same-account private peer is available.
  if (process.platform !== "linux" || uid === undefined || uid === 0 || route.SUDO_USER) {
    return undefined;
  }
  const runtime = route.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`;
  if (!path.isAbsolute(runtime)) {
    return undefined;
  }
  const unit = `${resolveSystemdServiceName(env)}.service`;
  let broker: Awaited<ReturnType<typeof openSystemdBroker>> | undefined;
  const query = async (method: string, name: string, signature: string) => {
    if (!broker) {
      throw unavailable();
    }
    const values = await broker.query(
      ["call", BUS, "/org/freedesktop/DBus", BUS, method, "s", name],
      [signature],
      deadline,
    );
    const tuple = values?.[0];
    if (!Array.isArray(tuple) || tuple.length !== 1) {
      throw unavailable();
    }
    return tuple[0];
  };
  let peer: Awaited<ReturnType<typeof openSystemdPrivatePeer>> | undefined;
  try {
    const brokerAddress =
      route.DBUS_SESSION_BUS_ADDRESS?.trim() ||
      `unix:path=${encodeURIComponent(path.join(runtime, "bus")).replaceAll("%2F", "/")}`;
    if (!isLocalUnixAddress(brokerAddress)) {
      return undefined;
    }
    broker = await openSystemdBroker(brokerAddress, deadline);
    const destination = await query("GetNameOwner", MANAGER, "s");
    if (typeof destination !== "string" || !/^:[0-9]+\.[0-9]+$/.test(destination)) {
      throw unavailable();
    }
    if ((await query("GetConnectionUnixUser", destination, "u")) !== uid) {
      throw unavailable();
    }
    const pid = await query("GetConnectionUnixProcessID", destination, "u");
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
      throw unavailable();
    }
    const startTime = getProcessStartTime(pid);
    if (startTime === null) {
      throw unavailable();
    }
    // Percent escaping is D-Bus address syntax, not a shell expansion. Preserve
    // authored runtime roots; never probe a different canonical manager.
    const socket = path.join(runtime, "systemd/private");
    const address = `unix:path=${encodeURIComponent(socket).replaceAll("%2F", "/")}`;
    peer = await openSystemdPrivatePeer(address, { uid, pid, startTime }, deadline);
    if (
      (await query("GetNameOwner", MANAGER, "s")) !== destination ||
      (await query("GetConnectionUnixProcessID", destination, "u")) !== pid
    ) {
      throw unavailable();
    }
    peer.verify();
    const retained = peer;
    let unitPath: string | undefined;
    return {
      unit,
      managerUid: uid,
      destination,
      verify: retained.verify,
      close: retained.close,
      async query(args, signatures, until, inspection) {
        retained.verify();
        if (args[1] !== destination) {
          throw unavailable();
        }
        if (args[0] === "call") {
          const method = args[4] ?? "";
          const managerRead = ["GetUnit", "GetUnitFileState", "GetUnitProcesses"].includes(method);
          const ownedLoad = method === "LoadUnit" && inspection?.managerUid === uid;
          if (managerRead || ownedLoad) {
            if (
              args[2] !== "/org/freedesktop/systemd1" ||
              args[3] !== `${MANAGER}.Manager` ||
              args[5] !== "s" ||
              args[6] !== unit
            ) {
              throw unavailable();
            }
          } else if (
            method !== "GetProcesses" ||
            args[3] !== `${MANAGER}.Service` ||
            !unitPath ||
            args[2] !== unitPath ||
            args.length !== 5
          ) {
            throw unavailable();
          }
          if (ownedLoad) {
            inspection!.assertCurrent();
          }
        } else if (
          args[0] !== "get-property" ||
          !unitPath ||
          args[2] !== unitPath ||
          ![`${MANAGER}.Unit`, `${MANAGER}.Service`].includes(args[3] ?? "")
        ) {
          throw unavailable();
        }
        const assertCurrent =
          args[4] === "LoadUnit"
            ? inspection?.assertCurrent
            : (inspection?.assertReadCurrent ?? inspection?.assertCurrent);
        const values = await retained.query(args, signatures, until, assertCurrent);
        if (args[0] === "call" && ["GetUnit", "LoadUnit"].includes(args[4] ?? "") && values) {
          const [value] = values;
          if (
            !Array.isArray(value) ||
            value.length !== 1 ||
            typeof value[0] !== "string" ||
            !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(value[0])
          ) {
            throw unavailable();
          }
          if (unitPath && value[0] !== unitPath) {
            throw unavailable();
          }
          unitPath = value[0];
        }
        return values;
      },
    };
  } catch {
    await peer?.close();
    // Failure to establish an optional peer leaves existing broker inspection
    // intact. Once admitted, retained queries fail closed; they never re-admit.
    return undefined;
  } finally {
    await broker?.close();
  }
}
