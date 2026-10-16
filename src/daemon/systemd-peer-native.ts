/** OpenClaw admission and budgets around native-owned systemd connections. */
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import {
  SystemdBus,
  type AuthenticatedSystemdBus,
  type SystemdArg,
  type SystemdSignature,
  type SystemdValue,
} from "@openclaw/proc-safe/systemd";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import {
  getServiceInspectionClock,
  runServiceInspectionGuard,
} from "./service-inspection-budget.js";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "./service-inspection-error.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { createSystemdPeerQueue } from "./systemd-peer-queue.js";

export type SystemdPeerIdentity = { uid: number; pid: number; startTime: number };
const unavailable = () => new Error("Original systemd manager peer inspection is unavailable.");
const MAX_VALUES = 16384;
const MAX_STRING_BYTES = 1024 * 1024;

function remaining(deadline: number, now: () => number): number {
  assertGatewayServiceUpdateCurrent();
  const timeoutMs = deadline - now();
  if (timeoutMs <= 0) {
    throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
  }
  return timeoutMs;
}

function signature(value: string | undefined): SystemdSignature {
  switch (value) {
    case "s":
    case "o":
    case "u":
    case "i":
    case "t":
    case "b":
    case "(sb)":
    case "(sus)":
    case "(sasbttttuii)":
    case "as":
    case "ao":
    case "au":
    case "ai":
    case "at":
    case "ab":
    case "a(sb)":
    case "a(sus)":
    case "a(sasbttttuii)":
      return value;
    default:
      throw unavailable();
  }
}

/** Methods, unlike properties, carry their own wire signature in the reply. */
function matchesReply(value: unknown, expected: string): boolean {
  if (expected.startsWith("a")) {
    return Array.isArray(value) && value.every((entry) => matchesReply(entry, expected.slice(1)));
  }
  switch (expected) {
    case "s":
    case "o":
      return typeof value === "string";
    case "u":
    case "i":
      return typeof value === "number" && Number.isInteger(value);
    case "t":
      return typeof value === "bigint";
    case "b":
      return typeof value === "boolean";
    case "(sb)":
    case "(sus)":
    case "(sasbttttuii)": {
      const fields =
        expected === "(sb)"
          ? ["s", "b"]
          : expected === "(sus)"
            ? ["s", "u", "s"]
            : ["s", "as", "b", "t", "t", "t", "t", "u", "i", "i"];
      return (
        Array.isArray(value) &&
        value.length === fields.length &&
        fields.every((field, index) => matchesReply(value[index], field))
      );
    }
    default:
      return false;
  }
}

function translateFailure(error: unknown): never {
  if (
    error instanceof ProcSafeError &&
    error.code === "access-denied" &&
    error.details?.reason === "peer-uid-mismatch"
  ) {
    throw new ServiceOwnershipRefusalError("systemd-manager-changed");
  }
  if (error instanceof ProcSafeError && error.code === "timeout") {
    throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
  }
  throw error;
}

/** The caller already authenticated this exact manager through its selected broker. */
export async function openSystemdPrivatePeer(
  address: string,
  expected: SystemdPeerIdentity,
  deadline: number,
) {
  return openSystemdConnection(
    (timeoutMs) => SystemdBus.connectPrivatePeer(address, { timeoutMs }),
    deadline,
    expected,
  );
}

/** One broker connection: unique names never cross a reconnect or route fallback. */
export async function openSystemdBroker(address: string, deadline: number) {
  return openSystemdConnection(
    (timeoutMs) => SystemdBus.connectBroker(address, { timeoutMs }),
    deadline,
  );
}

/** Preserve systemctl's explicit user@ machine route on one broker connection. */
export async function openSystemdMachineBroker(machine: string, deadline: number) {
  return openSystemdConnection(
    (timeoutMs) => SystemdBus.connectMachineBroker(machine, { timeoutMs }),
    deadline,
  );
}

/** Ordinary local reads authenticate the connected manager without a session broker. */
export async function openSystemdUserManager(address: string, deadline: number) {
  return openSystemdConnection(
    (timeoutMs) => SystemdBus.connectUserManager(address, { timeoutMs }),
    deadline,
  );
}

async function openSystemdConnection(
  connect: (timeoutMs: number) => Promise<SystemdBus | AuthenticatedSystemdBus>,
  deadline: number,
  expected?: SystemdPeerIdentity,
) {
  const admissionNow = getServiceInspectionClock();
  let identity = expected;
  const bus = await connect(remaining(deadline, admissionNow)).catch(translateFailure);
  const peer = "peer" in bus ? bus.peer : undefined;
  let closed = false;
  const queue = createSystemdPeerQueue();
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    return (closing ??= queue.drain().then(() => bus.close()));
  };
  const verify = () => {
    assertGatewayServiceUpdateCurrent();
    if (closed) {
      throw unavailable();
    }
    if (identity) {
      const startTime = getProcessStartTime(identity.pid);
      if (startTime !== null && startTime !== identity.startTime) {
        throw new ServiceOwnershipRefusalError("systemd-manager-changed");
      }
      if (startTime === null || !isPidAlive(identity.pid)) {
        throw unavailable();
      }
    }
  };
  const verifyConnection = () => {
    verify();
    if (!peer) {
      return;
    }
    const { pid, uid } = peer;
    if (!identity) {
      const startTime = getProcessStartTime(pid);
      if (!isPidAlive(pid) || startTime === null) {
        throw unavailable();
      }
      identity = { uid, pid, startTime };
    }
    if (pid !== identity.pid || uid !== identity.uid) {
      throw new ServiceOwnershipRefusalError("systemd-manager-changed");
    }
    verify();
  };
  try {
    remaining(deadline, admissionNow);
    verifyConnection();
  } catch (error) {
    await close();
    throw error;
  }

  const execute = async (
    args: string[],
    signatures: string[],
    until: number,
    assertCurrent: (() => void) | undefined,
    beforeDispatch: (() => void) | undefined,
    now: () => number,
    mutationTimeoutMs?: number,
  ): Promise<unknown[] | null> => {
    let mutationDeadline: number | undefined;
    const check = () => {
      remaining(until, now);
      runServiceInspectionGuard(assertCurrent);
      verifyConnection();
      if (mutationDeadline !== undefined && performance.now() >= mutationDeadline) {
        throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
      }
    };
    const [operation, destination, path, iface, member] = args;
    if (!destination || !path || !iface || !member) {
      throw unavailable();
    }
    const target = { ...(peer ? {} : { destination }), path, interface: iface, member };
    let values = MAX_VALUES;
    let bytes = MAX_STRING_BYTES;
    const account = (value: SystemdValue): void => {
      if (--values < 0) {
        throw unavailable();
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          account(entry);
        }
      } else if (typeof value === "string") {
        bytes -= Buffer.byteLength(value);
        if (bytes < 0) {
          throw unavailable();
        }
      }
    };
    const options = () => ({
      timeoutMs: remaining(until, now),
      replyBudgetBytes: MAX_STRING_BYTES + MAX_VALUES * 8,
    });
    check();
    if (operation === "get-property") {
      if (args.length - 4 !== signatures.length) {
        throw unavailable();
      }
      const result: SystemdValue[] = [];
      for (let index = 0; index < signatures.length; index++) {
        const property = args[index + 4];
        if (!property) {
          throw unavailable();
        }
        const expectedSignature = signature(signatures[index]);
        check();
        const value = await bus
          .getProperty({ ...target, member: property }, expectedSignature, options())
          .catch(translateFailure);
        check();
        account(value);
        result.push(value);
      }
      return result;
    }
    if (operation !== "call" || signatures.length > 1) {
      throw unavailable();
    }
    const methodArgs: SystemdArg[] = [];
    if (args[5] === "s" && args.length === 7 && args[6] !== undefined) {
      methodArgs.push({ type: "s", value: args[6] });
    } else if (
      args[5] === "ss" &&
      args.length === 8 &&
      args[6] !== undefined &&
      args[7] !== undefined
    ) {
      methodArgs.push({ type: "s", value: args[6] }, { type: "s", value: args[7] });
    } else if (args.length !== 5) {
      throw unavailable();
    }
    const expectedSignature = signatures.length ? signature(signatures[0]) : undefined;
    check();
    beforeDispatch?.();
    const callOptions = options();
    if (mutationTimeoutMs !== undefined) {
      callOptions.timeoutMs = Math.min(callOptions.timeoutMs, mutationTimeoutMs);
      mutationDeadline = performance.now() + callOptions.timeoutMs;
    }
    let reply: SystemdValue;
    try {
      reply = await bus.call(target, methodArgs, callOptions);
    } catch (error) {
      check();
      const name = error instanceof ProcSafeError ? error.details?.dbusErrorName : undefined;
      if (
        ((member === "GetUnit" || member === "LoadUnit") &&
          name === "org.freedesktop.systemd1.NoSuchUnit") ||
        (member === "GetUnitFileState" &&
          [
            "org.freedesktop.systemd1.NoSuchUnit",
            "org.freedesktop.systemd1.NoSuchUnitFile",
            "org.freedesktop.DBus.Error.FileNotFound",
          ].includes(String(name)))
      ) {
        return null;
      }
      translateFailure(error);
    }
    check();
    if (
      !Array.isArray(reply) ||
      reply.length !== signatures.length ||
      (expectedSignature && !matchesReply(reply[0], expectedSignature))
    ) {
      throw unavailable();
    }
    if (expectedSignature) {
      account(reply[0]);
      return [reply];
    }
    return [];
  };
  return {
    verify,
    close,
    query(
      args: string[],
      signatures: string[],
      until: number,
      assertCurrent?: () => void,
      beforeDispatch?: () => void,
      mutationTimeoutMs?: number,
    ) {
      const now = getServiceInspectionClock();
      return queue.run(
        until,
        () =>
          execute(args, signatures, until, assertCurrent, beforeDispatch, now, mutationTimeoutMs),
        now,
      );
    },
  };
}
