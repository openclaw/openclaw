import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import type { QueuedSessionDelivery } from "./session-delivery-queue.records.js";
import { sessionDeliveryOperations } from "./session-delivery-queue.worker.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  upsert: vi.fn(),
  complete: vi.fn(),
  owners: vi.fn(),
  prepareTerminal: vi.fn(),
  terminalize: vi.fn(),
  update: vi.fn(),
}));

vi.mock(import("./delivery-queue-sqlite-bound.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadDeliveryQueueEntryInDatabase: mocks.load,
  upsertBoundDeliveryQueueEntryInDatabase: mocks.upsert,
}));

vi.mock(import("./delivery-queue-sqlite.kernel.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  completeDeliveryQueueEntryInDatabase: mocks.complete,
  getDeliveryQueueEntryOwnersInDatabase: mocks.owners,
  prepareDeliveryQueueTerminalEntry: mocks.prepareTerminal,
  terminalizePendingDeliveryQueueEntryInDatabase: mocks.terminalize,
  updateDeliveryQueueEntryInDatabase: mocks.update,
}));

const database: OpenClawStateDatabase = {
  path: "synthetic-session-delivery.sqlite",
  get db(): never {
    throw new Error("Unexpected unmocked database access");
  },
  get walMaintenance(): never {
    throw new Error("Unexpected unmocked WAL access");
  },
};
const id = "session-delivery";
const entry: QueuedSessionDelivery = {
  kind: "systemEvent",
  sessionKey: "agent:main:main",
  text: "synthetic delivery",
  id,
  enqueuedAt: 1,
  retryCount: 0,
};
const context: WorkerWriteOperationContext = {
  open: () => database,
  stateOptions: () => ({ path: database.path, env: {} }),
  write: (operation) => operation(database),
  writeAdmitted: (operation) => operation(database),
};
const settlement = bindDeliveryQueueEntry(
  { queueName: "session", entry, updatePendingOnly: true },
  1,
);
const terminalEntry = {
  queueName: "session",
  id,
  expectedStatus: undefined,
  now: 1,
  expectedJson: JSON.stringify(entry),
  retention: undefined,
  failedEntry: undefined,
};
const transitions = [
  {
    name: "sessionDelivery.markSettlement",
    run: () => sessionDeliveryOperations["sessionDelivery.markSettlement"](settlement, context),
    write: mocks.upsert,
    args: [settlement, database],
    databaseIndex: 1,
    terminal: "completed",
    opposite: "failed",
  },
  {
    name: "sessionDelivery.complete",
    run: () => sessionDeliveryOperations["sessionDelivery.complete"]({ id }, context),
    write: mocks.complete,
    args: [database, "session", id],
    databaseIndex: 0,
    terminal: "completed",
    opposite: "failed",
  },
  {
    name: "sessionDelivery.moveToFailed",
    run: () => sessionDeliveryOperations["sessionDelivery.moveToFailed"]({ id }, context),
    write: mocks.terminalize,
    args: [database, terminalEntry],
    databaseIndex: 0,
    terminal: "failed",
    opposite: "completed",
  },
] as const;
let order: string[];

beforeEach(() => {
  vi.resetAllMocks();
  order = [];
  mocks.load.mockReturnValue(entry);
  mocks.upsert.mockReturnValue(true);
  mocks.prepareTerminal.mockReturnValue(terminalEntry);
  mocks.terminalize.mockReturnValue({ status: "terminalized", retained: false });
});

function expectOneWrite(transition: (typeof transitions)[number]) {
  for (const write of [mocks.upsert, mocks.complete, mocks.terminalize, mocks.update]) {
    expect(write).toHaveBeenCalledTimes(write === transition.write ? 1 : 0);
  }
  expect(transition.write).toHaveBeenCalledWith(...transition.args);
  expect(transition.write.mock.calls[0]?.[transition.databaseIndex]).toBe(database);
}

function expectStatusReads(count: number) {
  expect(mocks.owners).toHaveBeenCalledTimes(count);
  for (let index = 0; index < count; index += 1) {
    expect(mocks.owners).toHaveBeenNthCalledWith(index + 1, database, ["session"], id);
    expect(mocks.owners.mock.calls[index]?.[0]).toBe(database);
  }
}

function failTransition(write: typeof mocks.upsert) {
  const error = new Error("Original transition failure");
  write.mockImplementationOnce(() => {
    order.push("transition");
    throw error;
  });
  return error;
}

for (const transition of transitions) {
  describe(transition.name, () => {
    it(`accepts the failed transition when durable state is ${transition.terminal}`, () => {
      failTransition(transition.write);
      mocks.owners.mockImplementationOnce(() => {
        order.push("status");
        return new Map([["session", { status: transition.terminal }]]);
      });

      expect(transition.run()).toBeUndefined();

      expect(order).toEqual(["transition", "status"]);
      expectOneWrite(transition);
      expectStatusReads(1);
    });

    it.each(["pending", "opposite", "missing", "read failure"] as const)(
      "preserves the original thrown value when status is %s",
      (observation) => {
        const originalError = failTransition(transition.write);
        mocks.owners.mockImplementationOnce(() => {
          order.push("status");
          if (observation === "read failure") {
            throw new Error("Secondary status failure");
          }
          if (observation === "missing") {
            return new Map();
          }
          const status = observation === "pending" ? "pending" : transition.opposite;
          return new Map([["session", { status }]]);
        });
        let thrown: unknown;

        try {
          transition.run();
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBe(originalError);
        expect(order).toEqual(["transition", "status"]);
        expectOneWrite(transition);
        expectStatusReads(1);
      },
    );

    it("does not reconcile status after a successful transition", () => {
      expect(transition.run()).toBeUndefined();

      expectOneWrite(transition);
      expectStatusReads(0);
    });
  });
}

it("rechecks settlement status after the initial read still reports pending", () => {
  mocks.upsert.mockImplementationOnce(() => {
    order.push("transition");
    return false;
  });
  mocks.owners
    .mockImplementationOnce(() => {
      order.push("initial status");
      return new Map([["session", { status: "pending" }]]);
    })
    .mockImplementationOnce(() => {
      order.push("reconciliation status");
      return new Map([["session", { status: "completed" }]]);
    });

  expect(transitions[0].run()).toBeUndefined();

  expect(order).toEqual(["transition", "initial status", "reconciliation status"]);
  expectOneWrite(transitions[0]);
  expectStatusReads(2);
});
