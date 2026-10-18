import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureSqliteWorkerOpen } from "./sqlite-worker-broker-admission.js";
import { createSqliteWorkerLifecycle } from "./sqlite-worker-broker-lifecycle.js";
import type { Actor, Slot } from "./sqlite-worker-broker.types.js";
import { createSqliteWorkerClientActor } from "./sqlite-worker-client.test-support.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import { readSqliteWorkerRequestCustody } from "./sqlite-worker-request-custody.js";

const createCpuTrackedWorker = vi.hoisted(() => vi.fn());
vi.mock("./worker-cpu.js", () => ({ createCpuTrackedWorker }));
// mock-isolation: Use synthetic workers without selecting a native SQLite library.
vi.mock("./bun-sqlite-library.js", () => ({ ensureSqliteLibrarySelected() {} }));

function makeWorker() {
  return Object.assign(new EventEmitter(), {
    unref: vi.fn(),
    terminate: vi.fn(async () => 0),
  });
}

function runtimeFixture(
  overrides: Partial<Parameters<typeof createSqliteWorkerLifecycle>[0]> = {},
) {
  createCpuTrackedWorker.mockReset();
  const workers: ReturnType<typeof makeWorker>[] = [];
  createCpuTrackedWorker.mockImplementation(() => {
    const worker = makeWorker();
    workers.push(worker);
    return worker;
  });
  const slots = new Set<Slot>();
  const lifecycle = createSqliteWorkerLifecycle({
    explicitSqliteCloseReleasesNativeResources: true,
    actors: new Map(),
    slots,
    stores: new Map(),
    enqueueClose: vi.fn(),
    fail: (slot, reason) => {
      slot.failed = reason instanceof Error ? reason : new Error(String(reason));
    },
    ...overrides,
  });
  const options = captureSqliteWorkerOpen({
    moduleUrl: new URL("file:///openclaw/dist/backend.js"),
    databasePath: "/state/openclaw.sqlite",
    input: undefined,
  });
  const replyOwner = () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() });
  const createSlot = (opening: Parameters<typeof lifecycle.createSlot>[0] = options) =>
    lifecycle.createSlot(opening, false, replyOwner);
  return { lifecycle, slots, workers, options, replyOwner, createSlot };
}

it("cancels slot waiters while retaining the worker until exit", async ({ signal }) => {
  const { lifecycle, slots, workers, options, replyOwner, createSlot } = runtimeFixture();
  const slot = createSlot();
  const custody = slot.custody.createRequest();
  custody.activate();
  custody.accept();
  const retired = vi.fn();
  const retirement = lifecycle.retire(slot).then(retired);
  expect(readSqliteWorkerRequestCustody(custody.descriptor)).toBe(false);
  expect(custody.dispatched).toBe(true);
  const cancel = new AbortController();
  const waiting = lifecycle.acquireSlot(
    { ...options, signal: cancel.signal },
    { maxWorkers: 1, maxStores: 1 },
    replyOwner,
  );
  const reason = new Error("opening deadline expired while previous worker retires");
  const rejected = expect(waiting).rejects.toBe(reason);
  cancel.abort(reason);
  try {
    await withinTest(rejected, signal);
    expect(retired).not.toHaveBeenCalled();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
  } finally {
    workers[0]?.emit("exit", 0);
    await retirement;
    await Promise.allSettled([waiting]);
  }
  expect(retired).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(1);
  expect(slots.size).toBe(0);
});

it.each([
  { owned: false, revoked: false },
  { owned: false, revoked: true },
  { owned: true, revoked: false },
  { owned: true, revoked: true },
])(
  "retains live opener authority outside its caller scope (owned: $owned, revoked: $revoked)",
  ({ owned, revoked }) => {
    const caller = new AsyncLocalStorage<{ current: boolean }>();
    const owner = { current: true };
    const refusal = new Error("Opening owner was revoked");
    const assertCurrent = () => {
      if (caller.getStore() !== owner) {
        throw new Error("Opening lost its caller authority context");
      }
      if (!owner.current) {
        throw refusal;
      }
    };
    const opening = caller.run(owner, () =>
      captureSqliteWorkerOpen(
        {
          moduleUrl: new URL("file:///openclaw/dist/device-auth-store.sqlite.js"),
          databasePath: "/state/openclaw.sqlite",
          input: undefined,
          ...(owned
            ? { existingOnly: true, admission: { identity: "file:opening", assertCurrent } }
            : {}),
        },
        undefined,
        assertCurrent,
      ),
    );
    const { createSlot } = runtimeFixture();
    owner.current = !revoked;
    const dispatch = () => createSlot(opening);
    if (revoked) {
      expect(dispatch).toThrow(refusal);
      expect(createCpuTrackedWorker).not.toHaveBeenCalled();
    } else {
      expect(dispatch).not.toThrow();
    }
    if (owned) {
      assert(opening.createOpenAdmission);
      const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
      const { admission } = opening.createOpenAdmission({ settled: settlement.promise });
      const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
        admission.service();
        return "ok";
      });
      const admit = () =>
        withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
          requestSqliteWorkerOperationAdmission({ stage: "open", facts: undefined }),
        );
      try {
        if (revoked) {
          expect(admit).toThrow("admission was refused");
          expect(admission.failure).toBe(refusal);
        } else {
          expect(admit).not.toThrow();
        }
      } finally {
        wait.mockRestore();
        admission.finish();
      }
    }
    expect(caller.getStore()).toBeUndefined();
  },
);

// Bun resolves a `file:` preload by stripping "file://", so tsx's URL breaks on Windows.
it.each([
  { runtime: "Node", bun: undefined, execArgv: ["--import", import.meta.resolve("tsx/esm")] },
  { runtime: "Bun", bun: "1.4.3", execArgv: [] },
])("gives $runtime source workers only the TypeScript loader they need", ({ bun, execArgv }) => {
  const versions = Object.getOwnPropertyDescriptor(process, "versions");
  Object.defineProperty(process, "versions", {
    configurable: true,
    value: { ...process.versions, bun },
  });
  try {
    const { createSlot } = runtimeFixture();
    createSlot({ carrierUrl: new URL("file:///openclaw/src/infra/sqlite-store.worker.ts") });
    expect(createCpuTrackedWorker).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({ execArgv }),
    );
  } finally {
    if (versions) {
      Object.defineProperty(process, "versions", versions);
    }
  }
});

it.each([
  { capable: true, closeFails: false },
  { capable: false, closeFails: false },
  { capable: true, closeFails: true },
  { capable: false, closeFails: true },
])(
  "settles native custody after close or required exit (capable: $capable, failed: $closeFails)",
  async ({ capable, closeFails }) => {
    const terminating = createDeferredCore();
    const actors = new Map<string, Actor>();
    const error = new Error("native close failed");
    const { lifecycle, workers, createSlot } = runtimeFixture({
      explicitSqliteCloseReleasesNativeResources: capable,
      actors,
      enqueueClose: closeFails
        ? vi.fn().mockRejectedValue(error)
        : vi.fn().mockResolvedValue(undefined),
      fail: () => terminating.resolve(),
    });
    const slot = createSlot();
    const worker = workers[0]!;
    worker.terminate.mockImplementation(() => {
      terminating.resolve();
      return Promise.resolve(0);
    });
    const markNativeStopped = vi.fn();
    const actor = Object.defineProperty(createSqliteWorkerClientActor(), "slot", { value: slot });
    Object.assign(actor, { references: 0, markNativeStopped });
    actors.set(actor.key, actor);
    slot.actors.add(actor);
    // A pending sibling open prevents the ordinary empty-slot retirement path.
    const settled = vi.fn();
    const closing = lifecycle.closeActor(actor).finally(settled);
    const outcome = Promise.allSettled([closing]);
    if (!capable || closeFails) {
      await terminating.promise;
      expect(settled).not.toHaveBeenCalled();
      expect(markNativeStopped).not.toHaveBeenCalled();
      worker.emit("exit", 0);
    } else {
      await closing;
      expect(worker.terminate).not.toHaveBeenCalled();
    }
    expect(await outcome).toEqual([
      closeFails
        ? { status: "rejected", reason: error }
        : { status: "fulfilled", value: undefined },
    ]);
    expect(markNativeStopped).toHaveBeenCalledOnce();
    expect(actors.size).toBe(0);
  },
);
