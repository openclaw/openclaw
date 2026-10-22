import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  classifyGatewayOwnerProcessNamespace,
  GatewayProcessNamespaceSchema,
  type LockPayload,
} from "./gateway-lock-payload.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-schema.js";

export type StateLeaseProcessOwner = {
  pid: number;
  host: string;
  startedAt: number | null;
  processNamespace?: LockPayload["processNamespace"];
};

export type NamespacedStateLeaseProcessOwner = StateLeaseProcessOwner & {
  namespace: string | null;
};

let selfNamespace: string | undefined;

function readMachineIdentity(): string | null {
  try {
    let identity: string | undefined;
    if (process.platform === "linux") {
      const value = readFileSync("/etc/machine-id", "utf8").trim();
      if (/^[a-f0-9]{32}$/u.test(value)) {
        identity = value;
      }
    } else if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const matches = [...(result.stdout ?? "").matchAll(/"IOPlatformUUID"\s*=\s*"([^"]+)"/gu)];
      const value = matches.length === 1 ? matches[0]?.[1]?.toLowerCase() : undefined;
      if (
        !result.error &&
        result.status === 0 &&
        value &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
      ) {
        identity = value;
      }
    }
    if (!identity || /^0+$/u.test(identity.replaceAll("-", ""))) {
      return null;
    }
    // OS machine identifiers are confidential; retain only this purpose-specific digest.
    return createHmac("sha256", "openclaw:state-lease-process-owner:machine:v1")
      .update(`${process.platform}\0${identity}`)
      .digest("hex");
  } catch {
    return null;
  }
}

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
    return { ...boot.data, identity: boot.data.identity.toLowerCase(), machineIdentity };
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
      const pidNamespace = process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : null;
      if (boot.identity && (process.platform !== "linux" || pidNamespace)) {
        namespace = JSON.stringify([
          boot.platform,
          boot.identity,
          pidNamespace,
          readMachineIdentity(),
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
