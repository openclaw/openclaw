import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  leaseHeartbeatState as state,
  type LeaseHeartbeatReply,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";

const fixture = vi.hoisted(() => ({
  parent: undefined as MessagePort | undefined,
  data: undefined as LeaseHeartbeatWorkerData | undefined,
  renew: vi.fn<() => number | undefined>(),
  readExpiry: vi.fn<() => number | undefined>(),
  ports: new Set<MessagePort>(),
}));

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: false,
  get workerData() {
    return fixture.data;
  },
  get parentPort() {
    return fixture.parent;
  },
}));
vi.mock("../infra/gateway-state-owner.js", () => ({
  assertStateDatabaseAccessAllowed() {},
  GatewayStateOwnerContentionError: class extends Error {},
}));
vi.mock("../infra/sqlite-busy-timeout.js", () => ({
  runWithSqliteBusyTimeout: (_db: unknown, _ms: number, run: () => unknown) => run(),
}));
// mock-isolation: Request classification injects storage outcomes; native heartbeat tests own SQLite.
vi.mock("../infra/sqlite-transaction.js", () => ({
  runSqliteImmediateTransactionSync: (_db: unknown, run: () => unknown) => run(),
  runSqliteDeferredTransactionSync: (_db: unknown, run: () => unknown) => run(),
  runSqliteReadSnapshotSync: (_db: unknown, run: () => unknown) => run(),
  retainSqliteWriteAdmissionService: () => () => {},
}));
vi.mock("./openclaw-state-db-handle.js", () => ({
  openTrackedStateDatabase: () => ({}),
  closeTrackedStateDatabase() {},
}));
vi.mock("./openclaw-state-lease-store.js", () => ({
  renewOpenClawStateLeaseInTransaction: fixture.renew,
  readOpenClawStateLeaseExpiry: fixture.readExpiry,
}));

const acquiredAt = 1_800_000_000_000;
function track(port: MessagePort) {
  fixture.ports.add(port);
  port.once("close", () => fixture.ports.delete(port));
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(acquiredAt + 100);
  fixture.renew.mockReset().mockReturnValue(acquiredAt + 60_000);
  fixture.readExpiry.mockReset().mockReturnValue(acquiredAt + 60_000);
});
afterEach(async () => {
  await Promise.all(
    [...fixture.ports].map(
      (port) =>
        new Promise<void>((resolve) => {
          port.once("close", resolve);
          port.close();
        }),
    ),
  );
  vi.useRealTimers();
});

it.each([
  ["verify", true],
  ["renew", false],
  ["renew", true],
] as const)("classifies explicit %s loss with operation error=%s", async (operation, throws) => {
  const { port1: host, port2: parent } = new MessageChannel();
  const admission = new MessageChannel();
  for (const port of [host, parent, admission.port1, admission.port2]) {
    track(port);
  }
  fixture.parent = parent;
  fixture.data = {
    path: "/synthetic-state/lease.sqlite",
    expectedIdentity: "file:12:34",
    identity: { scope: "test:diagnostics", key: "lease", owner: "owner" },
    databaseAdmissionPort: admission.port1,
    leaseMs: 60_000,
    heartbeatMs: 20_000,
    acquiredAt,
    shared: new SharedArrayBuffer((state.ownerFence + 1) * BigInt64Array.BYTES_PER_ELEMENT),
    renewalProgress: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
  };
  Atomics.store(
    new BigInt64Array(fixture.data.shared),
    state.expiresAt,
    BigInt(acquiredAt + 60_000),
  );
  const ready = createDeferredCore();
  const result = createDeferredCore<Extract<LeaseHeartbeatReply, { id: number }>>();
  const losses: unknown[] = [];
  host.on(
    "message",
    (message: LeaseHeartbeatReply | { port: MessagePort } | { closed: true } | null) => {
      if (message === null) {
        ready.resolve();
      } else if ("port" in message) {
        track(message.port);
      } else if ("loss" in message) {
        losses.push(message.loss);
      } else if ("id" in message) {
        result.resolve(message);
      }
    },
  );
  await import("./openclaw-state-lease-heartbeat.worker.js");
  await ready.promise;
  const action = operation === "verify" ? fixture.readExpiry : fixture.renew;
  action.mockImplementation(() => {
    if (throws) {
      throw new Error("synthetic operation failure");
    }
    return undefined;
  });
  host.postMessage({ id: 1, operation }, []);
  const reply = await result.promise;
  assert(!reply.ok, "Expected a classified lease failure");
  expect(reply.payload?.nodes[reply.payload.root]).toMatchObject({
    code: throws ? "OPENCLAW_STATE_LEASE_STORAGE_FAILED" : "OPENCLAW_STATE_LEASE_LOST",
  });
  if (throws) {
    expect(reply.payload?.nodes).toContainEqual(
      expect.objectContaining({
        message: "synthetic operation failure",
      }),
    );
  }
  expect(losses).toEqual([
    {
      path: `explicit-${operation}`,
      outcome: throws ? "operation-error" : "no-current-owned-unexpired-row",
    },
  ]);
});
