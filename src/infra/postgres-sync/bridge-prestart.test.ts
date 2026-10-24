import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { preparePostgresBridge } from "./bridge-prestart.js";
import { PostgresSyncConnection } from "./connection.js";
import type { BridgeWorkerData } from "./protocol.js";

const observed = vi.hoisted(() => ({ workers: [] as { worker: Worker; control: Int32Array }[] }));

// Observe native transports without replacing their bootstrap, module loading, or messages.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        const data = args[1]?.workerData as BridgeWorkerData;
        observed.workers.push({ worker: this, control: new Int32Array(data.signal) });
      }
    },
  };
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
  await Promise.all(observed.workers.splice(0).map(({ worker }) => worker.terminate()));
});

function prepare(overrides: Partial<typeof params> = {}, signal?: AbortSignal) {
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

it("starts one real bridge before the factory, and connects only when that factory opens", async () => {
  const scope = prepare();
  expect(observed.workers).toHaveLength(1);
  const { worker, control } = observed.workers[0]!;
  await once(worker, "online");
  expect(Atomics.load(control, 0)).toBe(0);

  await scope.run(async () => {
    await Promise.resolve();
    const nested = prepare();
    nested.run(() => open());
  });
  expect(observed.workers).toHaveLength(1);
  expect(Atomics.load(control, 0)).toBe(1);
});

it.each(["url", "schema", "storeId"] as const)(
  "keeps a prestarted bridge exclusive to its %s",
  (field) => {
    const scope = prepare();
    scope.run(() => open({ [field]: `${params[field]}-other` }));
    expect(observed.workers).toHaveLength(2);
    expect(Atomics.load(observed.workers[0]!.control, 0)).toBe(0);
    expect(Atomics.load(observed.workers[1]!.control, 0)).toBe(1);
  },
);

it.each(["lockTimeoutMs", "statementTimeoutMs"] as const)(
  "keeps a prestarted bridge exclusive to its %s",
  (field) => {
    const scope = prepare();
    scope.run(() => open({ [field]: params[field] + 1 }));
    expect(observed.workers).toHaveLength(2);
    expect(Atomics.load(observed.workers[0]!.control, 0)).toBe(0);
    expect(Atomics.load(observed.workers[1]!.control, 0)).toBe(1);
  },
);

it.each(["dispose", "abort"] as const)("joins an unused bridge after %s", async (mode) => {
  const controller = new AbortController();
  const scope = prepare({}, controller.signal);
  const { worker, control } = observed.workers[0]!;
  await once(worker, "online");
  const exited = once(worker, "exit");
  if (mode === "abort") {
    controller.abort();
  } else {
    await scope[Symbol.asyncDispose]();
  }
  await exited;
  await scope[Symbol.asyncDispose]();
  expect(Atomics.load(control, 0)).toBe(0);
  expect(worker.threadId).toBe(-1);
});
