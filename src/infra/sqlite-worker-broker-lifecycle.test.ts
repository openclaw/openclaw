import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSqliteWorkerLifecycle } from "./sqlite-worker-broker-lifecycle.js";
import type { Actor } from "./sqlite-worker-broker.types.js";
import {
  getTrackedWorkerLifecycleSnapshot,
  trackNativeWorkerForCpu,
  type WorkerRetirementReason,
} from "./worker-cpu.js";

const createCpuTrackedWorker = vi.hoisted(() => vi.fn());
vi.mock("./worker-cpu.js", async (importOriginal) => ({
  // Only worker construction is faked; retirement counting stays the real registry.
  ...(await importOriginal<typeof import("./worker-cpu.js")>()),
  createCpuTrackedWorker,
}));
vi.mock("./bun-sqlite-library.js", () => ({
  ensureSqliteLibrarySelected: () => {},
}));

beforeEach(() => {
  createCpuTrackedWorker.mockReset();
});

afterEach(async () => {
  await flushLogger();
  resetLogger();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// The registry labels workers by script basename, so this carrier has to be a real file URL.
const STORE_WORKER_URL = new URL("./sqlite-store.worker.ts", import.meta.url);
const idleSource = 'require("node:worker_threads").parentPort.on("message", () => {});';

function retirementCount(reason: WorkerRetirementReason): number {
  const entry = getTrackedWorkerLifecycleSnapshot().workerLifecycle.find(
    (worker) => worker.script === "sqlite-store.worker.js",
  );
  return entry?.retired.find((retired) => retired.reason === reason)?.count ?? 0;
}

describe("SQLite worker slots", () => {
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
          moduleUrl: new URL("file:///openclaw/src/infra/device-auth-store.sqlite.ts"),
          databasePath: "/state/openclaw.sqlite",
          input: Buffer.alloc(0),
          existingOnly: false,
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
          moduleUrl: new URL("file:///openclaw/dist/device-auth-store.sqlite.js"),
          databasePath: "/state/openclaw.sqlite",
          input: Buffer.alloc(0),
          existingOnly: false,
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

  it("attributes a broker-requested retirement instead of an unattributed exit", async () => {
    const worker = new Worker(idleSource, { eval: true, execArgv: [] });
    try {
      await once(worker, "online");
      // The real registry must see the label the broker's carrier owns, in production order.
      trackNativeWorkerForCpu(worker, STORE_WORKER_URL);
      createCpuTrackedWorker.mockReturnValueOnce(worker);
      const lifecycle = createSqliteWorkerLifecycle({
        explicitSqliteCloseReleasesNativeResources: true,
        actors: new Map(),
        slots: new Set(),
        stores: new Map(),
        enqueueClose: vi.fn(),
        fail: vi.fn(),
      });
      const slot = lifecycle.createSlot(
        {
          carrierUrl: STORE_WORKER_URL,
          moduleUrl: new URL("file:///openclaw/src/infra/device-auth-store.sqlite.ts"),
          databasePath: "/state/openclaw.sqlite",
          input: Buffer.alloc(0),
          existingOnly: false,
        },
        false,
        () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }),
      );
      const closedBefore = retirementCount("closed");
      const exitBefore = retirementCount("exit");

      await lifecycle.retire(slot);

      expect(retirementCount("closed")).toBe(closedBefore + 1);
      expect(retirementCount("exit")).toBe(exitBefore);
    } finally {
      await worker.terminate();
    }
  });

  it("reports a worker that leaves on its own once, naming its cause", async () => {
    const logFile = path.join(tempDirs.make("openclaw-sqlite-worker-departure-"), "openclaw.log");
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
    const worker = new Worker('throw new Error("sqlite carrier lost");', {
      eval: true,
      execArgv: [],
    });
    // The registry attaches its exit listener at construction, so it forgets the worker
    // before this owner reacts; only a mark made on the error event can label the retirement.
    trackNativeWorkerForCpu(worker, STORE_WORKER_URL);
    createCpuTrackedWorker.mockReturnValueOnce(worker);
    const lifecycle = createSqliteWorkerLifecycle({
      explicitSqliteCloseReleasesNativeResources: true,
      actors: new Map(),
      slots: new Set(),
      stores: new Map(),
      enqueueClose: vi.fn(),
      fail: vi.fn(),
    });
    const slot = lifecycle.createSlot(
      {
        carrierUrl: STORE_WORKER_URL,
        moduleUrl: new URL("file:///openclaw/src/infra/device-auth-store.sqlite.ts"),
        databasePath: "/state/openclaw.sqlite",
        input: Buffer.alloc(0),
        existingOnly: false,
      },
      false,
      () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }),
    );
    const failureBefore = retirementCount("failure");
    const exitBefore = retirementCount("exit");

    // The owner's exit handler resolves this only after it has reported the departure.
    await slot.exit;
    await flushLogger();

    expect(retirementCount("failure")).toBe(failureBefore + 1);
    expect(retirementCount("exit")).toBe(exitBefore);
    const warnings = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("left without a retirement request"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sqlite carrier lost");
  });
});
