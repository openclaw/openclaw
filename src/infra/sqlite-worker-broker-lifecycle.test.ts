import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureSqliteWorkerOpen } from "./sqlite-worker-broker-admission.js";
import { createSqliteWorkerLifecycle } from "./sqlite-worker-broker-lifecycle.js";
import type { Actor, Slot } from "./sqlite-worker-broker.types.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";

const createCpuTrackedWorker = vi.hoisted(() => vi.fn());
vi.mock("./worker-cpu.js", () => ({ createCpuTrackedWorker }));
vi.mock("./bun-sqlite-library.js", () => ({
  ensureSqliteLibrarySelected: () => {},
}));

beforeEach(() => {
  createCpuTrackedWorker.mockReset();
});

describe("SQLite worker slots", () => {
  function runtimeFixture(autoExit = true) {
    const workers: (EventEmitter & {
      unref: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    })[] = [];
    createCpuTrackedWorker.mockImplementation(() => {
      const worker = Object.assign(new EventEmitter(), {
        unref: vi.fn(),
        terminate: vi.fn(() => {
          if (autoExit) {
            queueMicrotask(() => worker.emit("exit", 0));
          }
          return Promise.resolve(0);
        }),
      });
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
    });
    const options = captureSqliteWorkerOpen({
      moduleUrl: new URL("file:///openclaw/dist/backend.js"),
      databasePath: "/state/openclaw.sqlite",
      input: undefined,
    });
    const replyOwner = () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() });
    const source = { moduleUrl: options.moduleUrl.href, carrierUrl: options.carrierUrl };
    const close = (succeeded = true) =>
      lifecycle.closeHost({
        inputAdmission: {
          joinOpens: () =>
            succeeded ? Promise.resolve() : Promise.reject(new Error("fixture close refused")),
          joinPreparations: () => Promise.resolve(),
        },
        operations: [],
        waiters: [],
      });
    return { lifecycle, close, slots, workers, options, source, replyOwner };
  }

  it("reserves ordinary capacity and joins explicit prepared-runtime cancellation", async () => {
    const { lifecycle, slots, workers, source, replyOwner } = runtimeFixture(false);
    const prepared = lifecycle.prepareRuntime(source, 1, replyOwner);
    assert(prepared);
    expect(lifecycle.prepareRuntime(source, 1, replyOwner)).toBeUndefined();
    let released = false;
    const releasing = prepared.release().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(lifecycle.prepareRuntime(source, 1, replyOwner)).toBeUndefined();
    workers[0]?.emit("exit", 0);
    await releasing;
    expect(slots.size).toBe(0);
    const replacement = lifecycle.prepareRuntime(source, 1, replyOwner);
    assert(replacement);
    const replacing = replacement.release();
    workers[1]?.emit("exit", 0);
    await replacing;
  });

  it("yields optional capacity to an accepted ephemeral opener and later opens cold", async () => {
    const { lifecycle, close, slots, workers, options, source, replyOwner } = runtimeFixture();
    const prepared = lifecycle.prepareRuntime(source, 1, replyOwner);
    assert(prepared);
    const ephemeral = await lifecycle.acquireSlot(
      {
        ...options,
        target: { kind: "ephemeral", handle: "accepted", incarnation: "first" },
      },
      source.moduleUrl,
      { maxWorkers: 1, maxStores: 1 },
      replyOwner,
    );
    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    expect(ephemeral.ephemeral).toBe(true);
    expect(ephemeral.pendingOpens).toBe(1);
    expect(slots.size).toBe(1);
    await expect(
      lifecycle.rejectSlotAdmission(ephemeral, new Error("fixture open finished")),
    ).rejects.toThrow("fixture open finished");
    await close();
    const opening = { ...options, runtimePreparation: prepared };
    const cold = await lifecycle.acquireSlot(
      opening,
      source.moduleUrl,
      { maxWorkers: 1, maxStores: 1 },
      replyOwner,
    );
    expect(workers).toHaveLength(3);
    expect(cold.worker).not.toBe(ephemeral.worker);
    expect(cold.pendingOpens).toBe(1);
    expect(slots.size).toBe(1);
    await expect(
      lifecycle.acquireSlot(opening, source.moduleUrl, { maxWorkers: 1, maxStores: 1 }, replyOwner),
    ).rejects.toMatchObject({ code: "closed" });
    await prepared.release();
    expect(slots.has(cold)).toBe(true);
    await expect(
      lifecycle.rejectSlotAdmission(cold, new Error("fixture open finished")),
    ).rejects.toThrow("fixture open finished");
  });

  it.each(
    [
      "before-close",
      "second-close",
      "failed-close",
      "wrong-generation",
      "wrong-module",
      "wrong-carrier",
    ].flatMap((failure) => [false, true].map((preempted) => ({ failure, preempted }))),
  )(
    "refuses and retires $failure prepared runtime custody (preempted: $preempted)",
    async ({ failure, preempted }) => {
      const { lifecycle, close, slots, workers, options, source, replyOwner } = runtimeFixture();
      const prepared = lifecycle.prepareRuntime(source, 1, replyOwner);
      assert(prepared);
      if (preempted) {
        const accepted = await lifecycle.acquireSlot(
          options,
          source.moduleUrl,
          { maxWorkers: 1, maxStores: 1 },
          replyOwner,
        );
        await expect(
          lifecycle.rejectSlotAdmission(accepted, new Error("fixture open finished")),
        ).rejects.toThrow("fixture open finished");
      }
      if (failure === "failed-close") {
        await expect(close(false)).rejects.toThrow("SQLite worker host cleanup failed");
      } else if (failure !== "before-close") {
        await close();
      }
      if (failure === "second-close") {
        await close();
      }
      const opening = {
        ...options,
        runtimePreparation: prepared,
        ...(failure === "wrong-generation"
          ? { runtimeGeneration: { resolve: (url: URL) => url, retain() {} } }
          : {}),
        ...(failure === "wrong-carrier" ? { carrierUrl: new URL("file:///other-carrier.js") } : {}),
      };
      await expect(
        lifecycle.acquireSlot(
          opening,
          failure === "wrong-module" ? "file:///other.js" : source.moduleUrl,
          { maxWorkers: 1, maxStores: 1 },
          replyOwner,
        ),
      ).rejects.toMatchObject({ code: "closed" });
      expect(slots.size).toBe(0);
      expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    },
  );

  it("consumes captured preparation once without transferring another broker's custody", async () => {
    const { lifecycle, close, slots, options, source, replyOwner } = runtimeFixture();
    const prepared = lifecycle.prepareRuntime(source, 1, replyOwner);
    assert(prepared);
    await close();
    const foreign = runtimeFixture().lifecycle;
    const opening = captureSqliteWorkerOpen(
      {
        moduleUrl: options.moduleUrl,
        databasePath: options.databasePath,
        input: undefined,
      },
      undefined,
      undefined,
      { runtimePreparation: prepared },
    );
    await expect(
      foreign.acquireSlot(opening, source.moduleUrl, { maxWorkers: 1, maxStores: 1 }, replyOwner),
    ).rejects.toMatchObject({ code: "closed" });
    const adopted = await lifecycle.acquireSlot(
      opening,
      source.moduleUrl,
      { maxWorkers: 1, maxStores: 1 },
      replyOwner,
    );
    expect(adopted.pendingOpens).toBe(1);
    await expect(
      lifecycle.acquireSlot(opening, source.moduleUrl, { maxWorkers: 1, maxStores: 1 }, replyOwner),
    ).rejects.toMatchObject({ code: "closed" });
    await prepared.release();
    expect(slots.has(adopted)).toBe(true);
    await expect(
      lifecycle.rejectSlotAdmission(adopted, new Error("opening revoked")),
    ).rejects.toThrow("opening revoked");
    expect(slots.size).toBe(0);
  });

  it("cancels a slot waiter while the retiring worker keeps ownership until exit", async ({
    signal,
  }) => {
    const { lifecycle, slots, workers, options, source, replyOwner } = runtimeFixture(false);
    const slot = lifecycle.createSlot(options, false, replyOwner);
    let retired = false;
    const retirement = lifecycle.retire(slot).then(() => {
      retired = true;
    });
    const cancel = new AbortController();
    const waiting = lifecycle.acquireSlot(
      { ...options, signal: cancel.signal },
      source.moduleUrl,
      { maxWorkers: 1, maxStores: 1 },
      replyOwner,
    );
    const reason = new Error("opening deadline expired while previous worker retires");
    const rejected = expect(waiting).rejects.toBe(reason);
    cancel.abort(reason);
    try {
      await withinTest(rejected, signal);
      expect(retired).toBe(false);
      expect(workers).toHaveLength(1);
      expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
    } finally {
      workers[0]?.emit("exit", 0);
      await retirement;
      await Promise.allSettled([waiting]);
    }
    expect(retired).toBe(true);
    expect(workers).toHaveLength(1);
    expect(slots.size).toBe(0);
  });

  it.for(["capacity-preemption", "invalid-preparation", "consumed-preemption"] as const)(
    "cancels %s observation while prepared-runtime retirement retains the worker",
    async (kind, { signal }) => {
      const { lifecycle, close, slots, workers, options, source, replyOwner } =
        runtimeFixture(false);
      const prepared = lifecycle.prepareRuntime(source, 1, replyOwner);
      assert(prepared);
      const cancel = new AbortController();
      const preemptorCancel = new AbortController();
      const limits = { maxWorkers: 1, maxStores: 1 };
      const pending: Promise<unknown>[] = [];
      if (kind === "consumed-preemption") {
        await close();
        const preemptor = lifecycle.acquireSlot(
          { ...options, signal: preemptorCancel.signal },
          source.moduleUrl,
          limits,
          replyOwner,
        );
        pending.push(preemptor);
        void preemptor.catch(() => {});
      }
      const waiting = lifecycle.acquireSlot(
        {
          ...options,
          signal: cancel.signal,
          ...(kind === "capacity-preemption" ? {} : { runtimePreparation: prepared }),
        },
        source.moduleUrl,
        limits,
        replyOwner,
      );
      pending.push(waiting);
      const retirement = [...slots][0]?.retiring;
      assert(retirement);
      const retired = vi.fn();
      void retirement.then(retired, retired);
      const reason = new Error("prepared-runtime opening deadline expired");
      const rejected = expect(waiting).rejects.toBe(reason);
      cancel.abort(reason);
      try {
        await withinTest(rejected, signal);
        expect(retired).not.toHaveBeenCalled();
        expect(workers).toHaveLength(1);
        expect(workers[0]?.terminate).toHaveBeenCalledOnce();
        expect(slots.size).toBe(1);
        expect(lifecycle.prepareRuntime(source, 1, replyOwner)).toBeUndefined();
      } finally {
        preemptorCancel.abort(reason);
        workers[0]?.emit("exit", 0);
        await Promise.allSettled(pending);
        const remaining = [...slots].map((slot) => lifecycle.retire(slot));
        workers.forEach((worker) => worker.emit("exit", 0));
        await Promise.allSettled(remaining);
        await prepared.release();
      }
      expect(retired).toHaveBeenCalledOnce();
      expect(workers).toHaveLength(1);
      expect(slots.size).toBe(0);
    },
  );

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
      createCpuTrackedWorker.mockReturnValueOnce(
        Object.assign(new EventEmitter(), { unref: vi.fn() }),
      );
      const lifecycle = createSqliteWorkerLifecycle({
        explicitSqliteCloseReleasesNativeResources: true,
        actors: new Map(),
        slots: new Set(),
        stores: new Map(),
        enqueueClose: vi.fn(),
        fail: vi.fn(),
      });
      owner.current = !revoked;
      const dispatch = () =>
        lifecycle.createSlot(opening, false, () => ({
          fail: vi.fn(),
          finish: vi.fn(),
          dispatch: vi.fn(),
        }));
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
      createCpuTrackedWorker.mockReturnValueOnce(
        Object.assign(new EventEmitter(), { unref: vi.fn() }),
      );
      const lifecycle = createSqliteWorkerLifecycle({
        explicitSqliteCloseReleasesNativeResources: true,
        actors: new Map(),
        slots: new Set(),
        stores: new Map(),
        enqueueClose: vi.fn(),
        fail: vi.fn(),
      });
      lifecycle.createSlot(
        {
          carrierUrl: new URL("file:///openclaw/src/infra/sqlite-store.worker.ts"),
        },
        false,
        () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }),
      );
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
      const worker = Object.assign(new EventEmitter(), {
        unref: vi.fn(),
        terminate: vi.fn(() => {
          terminating.resolve();
          return Promise.resolve(0);
        }),
      });
      createCpuTrackedWorker.mockReturnValueOnce(worker);
      const actors = new Map<string, Actor>();
      const error = new Error("native close failed");
      const lifecycle = createSqliteWorkerLifecycle({
        explicitSqliteCloseReleasesNativeResources: capable,
        actors,
        slots: new Set(),
        stores: new Map(),
        enqueueClose: closeFails
          ? vi.fn().mockRejectedValue(error)
          : vi.fn().mockResolvedValue(undefined),
        fail: () => terminating.resolve(),
      });
      const slot = lifecycle.createSlot(
        {
          carrierUrl: new URL("file:///openclaw/dist/sqlite-store.worker.js"),
        },
        false,
        () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }),
      );
      const nativeStopped = createDeferredCore();
      const markNativeStopped = vi.fn(nativeStopped.resolve);
      const actor: Actor = {
        id: 1,
        key: "fixture",
        databasePath: "/state/openclaw.sqlite",
        pathReferences: new Map(),
        moduleUrl: "file:///openclaw/dist/device-auth-store.sqlite.js",
        inputHash: "fixture",
        slot,
        references: 0,
        opened: Promise.resolve(),
        openDispatch: { dispatched: true },
        initialized: true,
        backendClosed: false,
        nativeStopped: nativeStopped.promise,
        markNativeStopped,
      };
      actors.set(actor.key, actor);
      slot.actors.add(actor);
      // A pending sibling open prevents the ordinary empty-slot retirement path.
      let settled = false;
      const closing = lifecycle.closeActor(actor).finally(() => {
        settled = true;
      });
      const outcome = Promise.allSettled([closing]);
      if (!capable || closeFails) {
        await terminating.promise;
        expect(settled).toBe(false);
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
});
