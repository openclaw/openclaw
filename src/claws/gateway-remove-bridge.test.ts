import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  attachClawRemoveGatewayBridge,
  type ClawRemoveGatewayBridge,
} from "./gateway-remove-bridge.js";
import {
  CLAW_REMOVE_AUTHORITY_DENIED,
  CLAW_REMOVE_AUTHORITY_GRANTED,
  CLAW_REMOVE_AUTHORITY_REQUEST,
  type ClawRemoveBridgeResponse,
} from "./remove-gateway-bridge-protocol.js";

const configRevision = `sha256:${"A".repeat(43)}`;

function fakeChild() {
  const writes: Buffer[] = [];
  const control = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    },
  });
  const sent: ClawRemoveBridgeResponse[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, control],
    connected: true,
    send: (response: ClawRemoveBridgeResponse, callback: (error: Error | null) => void) => {
      sent.push(response);
      callback(null);
      return true;
    },
  });
  return { child, control, writes, sent };
}

function request(id: number, fields: Record<string, unknown>) {
  return { kind: "claw.remove.request", id, ...fields };
}

describe("Gateway Claw Remove child bridge", () => {
  it("limits a preview child to monitor inspection for the reviewed agent", async () => {
    const { child, sent } = fakeChild();
    const inspect = vi.fn(async () => []);
    attachClawRemoveGatewayBridge(
      child as unknown as ChildProcess,
      {
        previewOnly: true,
        agentId: "worker",
        assertCurrent: vi.fn(),
        monitorGateway: { inspect },
      },
      vi.fn(),
    );
    const digest = `sha256:${"a".repeat(64)}`;
    const requests = [
      request(1, { op: "monitor.inspect", agentId: "worker" }),
      request(2, { op: "monitor.inspect", agentId: "other-agent" }),
      request(3, { op: "monitor.quiesce", agentId: "worker", operationId: "op", monitors: [] }),
      request(4, { op: "monitor.drain", agentId: "worker", operationId: "op" }),
      request(5, {
        op: "package.remove",
        request: {
          agentId: "worker",
          operationId: "op",
          expectedInstallDigest: digest,
          expectedPackagePlanDigest: digest,
          cleanup: { mode: "retain", selected: [], allowConflicts: false },
        },
      }),
      request(6, { op: "cron.get", schedulerJobId: "scheduler-daily" }),
      request(7, {
        op: "cron.remove",
        schedulerJobId: "scheduler-daily",
        expectedConfigRevision: configRevision,
      }),
    ];
    for (const item of requests) {
      child.emit("message", item);
    }
    await vi.waitFor(() => expect(sent).toHaveLength(requests.length));
    const responses = new Map(sent.map((response) => [response.id, response]));
    expect(responses.get(1)?.ok).toBe(true);
    expect(requests.slice(1).every((item) => responses.get(item.id)?.ok === false)).toBe(true);
    expect(inspect).toHaveBeenCalledExactlyOnceWith("worker");
  });

  it("dispatches only scoped monitor, package, and cron operations", async () => {
    const { child, sent } = fakeChild();
    const inspect = vi.fn(async () => []);
    const quiesce = vi.fn(async () => {});
    const drain = vi.fn(async () => {});
    const removePackage = vi.fn(async () => ({ packages: [] }));
    const getCron = vi.fn(async () => null);
    const removeCron = vi.fn(async (_id: string, options?: { commitGuard?: () => void }) => {
      options?.commitGuard?.();
    });
    const bridge: ClawRemoveGatewayBridge = {
      agentId: "worker",
      assertCurrent: vi.fn(),
      allowedCronJobIds: new Set(["scheduler-daily"]),
      createCallbacks: () => ({
        monitorGateway: { inspect, quiesce, drain },
        packageGateway: removePackage,
        cronGateway: { get: getCron, remove: removeCron },
      }),
    };
    attachClawRemoveGatewayBridge(child as unknown as ChildProcess, bridge, vi.fn());
    const digest = `sha256:${"a".repeat(64)}`;
    const requests = [
      request(1, { op: "monitor.inspect", agentId: "worker" }),
      request(2, { op: "monitor.quiesce", agentId: "worker", operationId: "op", monitors: [] }),
      request(3, { op: "monitor.drain", agentId: "worker", operationId: "op" }),
      request(4, {
        op: "package.remove",
        request: {
          agentId: "worker",
          operationId: "op",
          expectedInstallDigest: digest,
          expectedPackagePlanDigest: digest,
          cleanup: { mode: "retain", selected: [], allowConflicts: false },
        },
      }),
      request(5, { op: "cron.get", schedulerJobId: "scheduler-daily" }),
      request(6, {
        op: "cron.remove",
        schedulerJobId: "scheduler-daily",
        expectedConfigRevision: configRevision,
      }),
    ];
    for (const item of requests) {
      child.emit("message", item);
    }
    await vi.waitFor(() => expect(sent).toHaveLength(requests.length));
    expect(sent.every((response) => response.ok)).toBe(true);
    expect(inspect).toHaveBeenCalledWith("worker");
    expect(quiesce).toHaveBeenCalledWith("worker", "op", []);
    expect(drain).toHaveBeenCalledWith("worker", "op");
    expect(removePackage).toHaveBeenCalledOnce();
    expect(getCron).toHaveBeenCalledWith("scheduler-daily");
    expect(removeCron).toHaveBeenCalledExactlyOnceWith("scheduler-daily", {
      expectedConfigRevision: configRevision,
      commitGuard: expect.any(Function),
    });

    child.emit(
      "message",
      request(7, {
        op: "cron.remove",
        schedulerJobId: "other-job",
        expectedConfigRevision: configRevision,
      }),
    );
    child.emit("message", request(8, { op: "monitor.inspect", agentId: "other-agent" }));
    child.emit(
      "message",
      request(9, {
        op: "package.remove",
        request: {
          agentId: "worker",
          operationId: "op",
          expectedInstallDigest: digest,
          expectedPackagePlanDigest: digest,
          cleanup: { mode: "remove-if-unused", selected: [], allowConflicts: false },
        },
      }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(9));
    expect(sent.slice(6).every((response) => !response.ok)).toBe(true);
    expect(removeCron).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    expect(removePackage).toHaveBeenCalledOnce();
  });

  it("denies synchronous fd3 grants after the original authority retires", async () => {
    const { child, control, writes } = fakeChild();
    let authorized = true;
    const abort = vi.fn();
    attachClawRemoveGatewayBridge(
      child as unknown as ChildProcess,
      {
        agentId: "worker",
        assertCurrent: () => {
          if (!authorized) {
            throw new Error("retired");
          }
        },
        allowedCronJobIds: new Set(),
        createCallbacks: () => ({
          monitorGateway: {
            inspect: async () => [],
            quiesce: async () => {},
            drain: async () => {},
          },
          packageGateway: async () => ({ packages: [] }),
          cronGateway: { get: async () => null, remove: async () => {} },
        }),
      },
      abort,
    );
    control.push(Buffer.from([CLAW_REMOVE_AUTHORITY_REQUEST]));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    authorized = false;
    control.push(Buffer.from([CLAW_REMOVE_AUTHORITY_REQUEST]));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map((reply) => reply[0])).toEqual([
      CLAW_REMOVE_AUTHORITY_GRANTED,
      CLAW_REMOVE_AUTHORITY_DENIED,
    ]);
    expect(abort).toHaveBeenCalled();
  });

  it("retires a pending package commit when its child exits", async () => {
    const { child } = fakeChild();
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let committed = false;
    attachClawRemoveGatewayBridge(
      child as unknown as ChildProcess,
      {
        agentId: "worker",
        assertCurrent: () => {},
        allowedCronJobIds: new Set(),
        createCallbacks: (assertCurrent) => ({
          monitorGateway: {
            inspect: async () => [],
            quiesce: async () => {},
            drain: async () => {},
          },
          packageGateway: async () => {
            await waiting;
            assertCurrent();
            committed = true;
            return { packages: [] };
          },
          cronGateway: { get: async () => null, remove: async () => {} },
        }),
      },
      vi.fn(),
    );
    const digest = `sha256:${"a".repeat(64)}`;
    child.emit(
      "message",
      request(1, {
        op: "package.remove",
        request: {
          agentId: "worker",
          operationId: "op",
          expectedInstallDigest: digest,
          expectedPackagePlanDigest: digest,
          cleanup: { mode: "retain" },
        },
      }),
    );
    child.emit("exit", 0, null);
    resume();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(committed).toBe(false);
  });
});
