import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { isContainerEnvironment } from "./container-environment.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import {
  classifyGatewayOwnerProcessNamespace,
  GatewayProcessNamespaceSchema,
  MachineIdentitySchema,
  type LockPayload,
} from "./gateway-lock-payload.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-schema.js";

export type StateLeaseProcessOwner = {
  pid: number;
  host: string;
  startedAt: number | null;
  processNamespace?: LockPayload["processNamespace"];
  machineIdentity?: LockPayload["machineIdentity"];
};

export type NamespacedStateLeaseProcessOwner = StateLeaseProcessOwner & {
  namespace: string | null;
};

let selfNamespace: string | undefined;

function parseNamespace(value: string | null) {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      return null;
    }
    const boot = managedHandoffBootSchema.safeParse({ platform: parsed[0], identity: parsed[1] });
    const pidNamespace: unknown = parsed[2];
    const machineIdentity: unknown = parsed[3];
    if (
      !boot.success ||
      (boot.data.platform === "linux"
        ? typeof pidNamespace !== "string" || !/^pid:\[\d+\]$/u.test(pidNamespace)
        : pidNamespace !== null) ||
      (machineIdentity !== null &&
        (typeof machineIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(machineIdentity)))
    ) {
      return null;
    }
    return {
      ...boot.data,
      identity: boot.data.identity.toLowerCase(),
      pidNamespace: typeof pidNamespace === "string" ? pidNamespace : null,
      machineIdentity,
    };
  } catch {
    return null;
  }
}

/** A PID is meaningful only in the original kernel and PID namespace. */
export function captureNamespacedStateLeaseProcessOwner(): NamespacedStateLeaseProcessOwner {
  let namespace = selfNamespace ?? null;
  if (namespace === null) {
    try {
      const boot = createManagedHandoffBootIdentityReader(process.env)();
      const pidNamespace = boot.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : null;
      if (boot.identity && (boot.platform !== "linux" || pidNamespace)) {
        namespace = JSON.stringify([
          boot.platform,
          boot.identity,
          pidNamespace,
          readProcessMachineIdentity(),
        ]);
        selfNamespace = namespace;
      }
    } catch {
      // Unknown identity preserves custody; a later successful capture may recover it.
    }
  }
  return {
    pid: process.pid,
    host: hostname(),
    startedAt: getFileLockProcessStartTime(process.pid),
    namespace,
  };
}

export function readNamespacedStateLeaseProcessOwnerStatus(
  owner: NamespacedStateLeaseProcessOwner,
  currentNamespace: string | null,
): "live" | "dead" | "unknown" {
  const previous = parseNamespace(owner.namespace);
  const current = parseNamespace(currentNamespace);
  if (!previous || !current || owner.host !== hostname()) {
    return "unknown";
  }
  if (owner.namespace === currentNamespace) {
    return readSameNamespaceProcessOwnerStatus(owner);
  }
  // A boot change proves controller death only on the same identified machine.
  // It never proves Docker extinction; the custody owner must still confirm that separately.
  return previous.platform === current.platform &&
    previous.machineIdentity !== null &&
    previous.machineIdentity === current.machineIdentity &&
    previous.identity !== current.identity
    ? "dead"
    : "unknown";
}

/** Linux gives its initial PID namespace, the host's own, this fixed inode. */
const INITIAL_LINUX_PID_NAMESPACE = "pid:[4026531836]";

/**
 * A process recorded under `namespace` on `host` is gone, children included, once
 * this same identified Linux or macOS host has booted again. On Linux both must be
 * in the host's own PID namespace: a container restart is not a host restart, and
 * container identities can repeat. A container sharing the host's PID namespace
 * still carries an image's identity, so no detected container proves it; the
 * detector cannot see one that leaves no runtime marker. Everything else proves
 * nothing.
 */
export function ranInEarlierHostBoot(
  owner: { host: string; namespace?: string | null },
  currentNamespace: string | null,
): boolean {
  const previous = parseNamespace(owner.namespace ?? null);
  const current = parseNamespace(currentNamespace);
  return (
    previous !== null &&
    current !== null &&
    !isContainerEnvironment() &&
    owner.host === hostname() &&
    previous.platform === current.platform &&
    (current.platform === "darwin" ||
      (current.platform === "linux" &&
        current.pidNamespace === INITIAL_LINUX_PID_NAMESPACE &&
        previous.pidNamespace === INITIAL_LINUX_PID_NAMESPACE)) &&
    current.machineIdentity !== null &&
    previous.machineIdentity === current.machineIdentity &&
    previous.identity !== current.identity
  );
}

export function parseStateLeaseProcessOwner(
  payloadJson: string | null,
): StateLeaseProcessOwner | null {
  const owner = safeParseJsonRecord(payloadJson ?? "")?.owner;
  if (!isRecord(owner)) {
    return null;
  }
  const { pid, host, startedAt } = owner;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    !host ||
    (startedAt !== null &&
      (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0))
  ) {
    return null;
  }
  return {
    pid,
    host,
    startedAt,
    ...(owner.machineIdentity === undefined
      ? {}
      : { machineIdentity: MachineIdentitySchema.safeParse(owner.machineIdentity).data ?? null }),
    ...(owner.processNamespace === undefined
      ? {}
      : {
          processNamespace:
            GatewayProcessNamespaceSchema.safeParse(owner.processNamespace).data ?? null,
        }),
  };
}

export function readStateLeaseProcessOwnerStatus(
  owner: StateLeaseProcessOwner | null,
  _heartbeatAt?: number,
): "live" | "dead" | "unknown" {
  if (!owner) {
    return "unknown";
  }
  const namespace = classifyGatewayOwnerProcessNamespace(owner.processNamespace, {
    ownerHost: owner.host,
    machineIdentity: owner.machineIdentity,
  });
  if (namespace !== "same") {
    return namespace;
  }
  return readSameNamespaceProcessOwnerStatus(owner);
}

function readSameNamespaceProcessOwnerStatus(
  owner: StateLeaseProcessOwner,
): "live" | "dead" | "unknown" {
  if (isPidDefinitelyDead(owner.pid)) {
    return "dead";
  }
  const currentStartedAt = getFileLockProcessStartTime(owner.pid);
  if (owner.startedAt === null || currentStartedAt === null) {
    return "unknown";
  }
  return currentStartedAt === owner.startedAt ? "live" : "dead";
}
