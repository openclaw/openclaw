import { DatabaseSync } from "node:sqlite";
import { MessagePort, type Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { preparePostgresBridge } from "./bridge-prestart.js";
import { PostgresSyncConnection } from "./connection.js";
import { closePostgresPool } from "./pool.js";
import type { BridgeWorkerData } from "./protocol.js";

const observed = vi.hoisted(() => ({ workers: [] as Worker[], connections: [] as Int32Array[] }));

// Observe native transports without replacing their bootstrap, module loading, or messages.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerConstructors } = await import("../../../test/helpers/worker-observer.js");
  return observeWorkerConstructors(actual, observed.workers);
});

const params = {
  url: "postgresql://[invalid",
  schema: "unused",
  storeId: "unused",
  lockTimeoutMs: 60_000,
  statementTimeoutMs: 90_000,
};
const prepared: ReturnType<typeof preparePostgresBridge>[] = [];
afterEach(async () => {
  await Promise.all(prepared.splice(0).map((scope) => scope[Symbol.asyncDispose]()));
  await closePostgresPool();
  observed.workers.length = 0;
  observed.connections.length = 0;
  vi.restoreAllMocks();
});

function observeConnections() {
  // Capture the native method; Reflect.apply below preserves each port's receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const post = MessagePort.prototype.postMessage;
  vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
    this: MessagePort,
    ...args
  ) {
    const data = args[0] as { connection?: BridgeWorkerData };
    if (data.connection) {
      observed.connections.push(new Int32Array(data.connection.signal));
    }
    return Reflect.apply(post, this, args);
  });
}

function prepare(overrides: Partial<typeof params> = {}, signal?: AbortSignal) {
  if (observed.connections.length === 0) {
    observeConnections();
  }
  const scope = preparePostgresBridge({ ...params, ...overrides }, signal);
  prepared.push(scope);
  return scope;
}

function open(overrides: Partial<typeof params> = {}) {
  const actual = { ...params, ...overrides };
  const anchor = new DatabaseSync(":memory:");
  try {
    expect(() =>
      withEngineStoreAdmission(
        () => new PostgresSyncConnection(actual.url, actual.schema, anchor, actual.storeId, actual),
      ),
    ).toThrow("Check database.postgres.connection, network, and credentials");
  } finally {
    anchor.close();
  }
}

it("prepares a logical bridge once and connects only when its factory opens", async () => {
  const scope = prepare();
  expect(observed.workers).toHaveLength(4);
  const control = observed.connections[0]!;
  expect(Atomics.load(control, 0)).toBe(0);
  await scope.run(async () => {
    await Promise.resolve();
    const nested = prepare();
    nested.run(() => open());
  });
  expect(observed.connections).toHaveLength(1);
  expect(Atomics.load(control, 0)).toBe(1);
});

it.each(["url", "schema", "storeId", "lockTimeoutMs", "statementTimeoutMs"] as const)(
  "keeps a prepared connection exclusive to its %s",
  (field) => {
    const scope = prepare();
    const value = params[field];
    scope.run(() => open({ [field]: typeof value === "number" ? value + 1 : `${value}-other` }));
    expect(observed.connections).toHaveLength(2);
    expect(Atomics.load(observed.connections[0]!, 0)).toBe(0);
    expect(Atomics.load(observed.connections[1]!, 0)).toBe(1);
    expect(observed.workers).toHaveLength(4);
  },
);

it.each(["dispose", "abort"] as const)(
  "releases an unused logical bridge after %s",
  async (mode) => {
    const controller = new AbortController();
    const scope = prepare({}, controller.signal);
    if (mode === "abort") {
      controller.abort();
    } else {
      await scope[Symbol.asyncDispose]();
    }
    await scope[Symbol.asyncDispose]();
    // Disposal must not terminate shared services needed by another connection.
    open();
    expect(observed.connections).toHaveLength(2);
    expect(Atomics.load(observed.connections[0]!, 0)).toBe(0);
    expect(Atomics.load(observed.connections[1]!, 0)).toBe(1);
    expect(observed.workers).toHaveLength(4);
  },
);
