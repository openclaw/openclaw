import { readSync, writeSync } from "node:fs";
import { z } from "zod";
import type { ClawCronGateway } from "../claws/cron.js";
import {
  clawMonitorSnapshotSchema,
  type ClawMonitorCleanupGateway,
} from "../claws/monitor-cleanup-contract.js";
import {
  clawPackageRemovalResultSchema,
  type ClawPackageRemovalGateway,
} from "../claws/package-remove-contract.js";
import {
  CLAW_REMOVE_AUTHORITY_GRANTED,
  CLAW_REMOVE_AUTHORITY_REQUEST,
  CLAW_REMOVE_GATEWAY_BRIDGE_ENV,
  clawRemoveBridgeResponseSchema,
  type ClawRemoveBridgeRequest,
} from "../claws/remove-gateway-bridge-protocol.js";
import { MAX_CLAW_MANIFEST_BYTES } from "../claws/source-limits.js";
import { hasErrnoCode } from "../infra/errno.js";

const AUTHORITY_FD = 3;
const AUTHORITY_TIMEOUT_MS = 30_000;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

function isRetryableIo(error: unknown): boolean {
  return hasErrnoCode(error, "EAGAIN") || hasErrnoCode(error, "EWOULDBLOCK");
}

function exchangeAuthorityByte(): void {
  const deadline = Date.now() + AUTHORITY_TIMEOUT_MS;
  const request = Buffer.from([CLAW_REMOVE_AUTHORITY_REQUEST]);
  let written = 0;
  while (written < request.length) {
    if (Date.now() >= deadline) {
      throw new Error("Gateway Claw removal authority timed out.");
    }
    try {
      const count = writeSync(AUTHORITY_FD, request, written, request.length - written);
      written += count;
      if (count === 0) {
        Atomics.wait(retryWait, 0, 0, 10);
      }
    } catch (error) {
      if (!isRetryableIo(error)) {
        throw error;
      }
      Atomics.wait(retryWait, 0, 0, 10);
    }
  }
  const reply = Buffer.alloc(1);
  while (Date.now() < deadline) {
    try {
      if (readSync(AUTHORITY_FD, reply, 0, 1, null) === 0) {
        break;
      }
      if (reply[0] === CLAW_REMOVE_AUTHORITY_GRANTED) {
        return;
      }
      break;
    } catch (error) {
      if (!isRetryableIo(error)) {
        throw error;
      }
      Atomics.wait(retryWait, 0, 0, 10);
    }
  }
  throw new Error("Gateway Claw removal authority is no longer active.");
}

export type ClawRemoveCliGatewayBridge = {
  assertCurrent: () => void;
  monitorGateway: ClawMonitorCleanupGateway;
  packageGateway: ClawPackageRemovalGateway;
  cronGateway: {
    get: NonNullable<ClawCronGateway["get"]>;
    remove: ClawCronGateway["remove"];
  };
  close: () => void;
};

export function createClawRemoveCliGatewayBridge(): ClawRemoveCliGatewayBridge | undefined {
  if (process.env[CLAW_REMOVE_GATEWAY_BRIDGE_ENV] !== "1") {
    return undefined;
  }
  if (!process.send || !process.channel) {
    throw new Error("Gateway Claw removal bridge is unavailable.");
  }
  let nextRequestId = 0;
  let active = true;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const failPending = (error: Error) => {
    active = false;
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  const onMessage = (value: unknown) => {
    const response = clawRemoveBridgeResponseSchema.safeParse(value);
    if (!response.success) {
      failPending(new Error("Gateway Claw removal response is invalid."));
      return;
    }
    const request = pending.get(response.data.id);
    if (!request) {
      failPending(new Error("Gateway Claw removal response has no request."));
      return;
    }
    pending.delete(response.data.id);
    if (response.data.ok) {
      request.resolve(response.data.value);
    } else {
      request.reject(new Error(response.data.error));
    }
  };
  const onDisconnect = () => failPending(new Error("Gateway Claw removal bridge disconnected."));
  process.on("message", onMessage);
  process.once("disconnect", onDisconnect);
  const assertCurrent = () => {
    if (!active || !process.connected) {
      throw new Error("Gateway Claw removal bridge is no longer active.");
    }
    try {
      exchangeAuthorityByte();
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Gateway Claw removal authority failed.");
      failPending(failure);
      throw failure;
    }
  };
  const invoke = async (request: ClawRemoveBridgeRequest): Promise<unknown> => {
    assertCurrent();
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded) > MAX_CLAW_MANIFEST_BYTES) {
      throw new Error("Gateway Claw removal request is too large.");
    }
    const value = await new Promise<unknown>((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
      process.send?.(request, (error) => {
        if (error) {
          pending.delete(request.id);
          reject(error);
        }
      });
    });
    assertCurrent();
    return value;
  };
  const id = () => ++nextRequestId;
  const monitorGateway: ClawMonitorCleanupGateway = {
    inspect: async (agentId) =>
      z
        .array(clawMonitorSnapshotSchema)
        .max(2)
        .parse(
          await invoke({ kind: "claw.remove.request", id: id(), op: "monitor.inspect", agentId }),
        ),
    quiesce: async (agentId, operationId, monitors) => {
      await invoke({
        kind: "claw.remove.request",
        id: id(),
        op: "monitor.quiesce",
        agentId,
        operationId,
        monitors,
      });
    },
    drain: async (agentId, operationId) => {
      await invoke({
        kind: "claw.remove.request",
        id: id(),
        op: "monitor.drain",
        agentId,
        operationId,
      });
    },
  };
  const packageGateway: ClawPackageRemovalGateway = async (request) =>
    clawPackageRemovalResultSchema.parse(
      await invoke({ kind: "claw.remove.request", id: id(), op: "package.remove", request }),
    );
  const cronGateway: ClawRemoveCliGatewayBridge["cronGateway"] = {
    get: async (schedulerJobId) =>
      await invoke({ kind: "claw.remove.request", id: id(), op: "cron.get", schedulerJobId }),
    remove: async (schedulerJobId) => {
      await invoke({ kind: "claw.remove.request", id: id(), op: "cron.remove", schedulerJobId });
    },
  };
  return {
    assertCurrent,
    monitorGateway,
    packageGateway,
    cronGateway,
    close: () => {
      failPending(new Error("Gateway Claw removal bridge closed."));
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    },
  };
}
