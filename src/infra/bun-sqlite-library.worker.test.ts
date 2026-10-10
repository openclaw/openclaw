import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import type { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerStore } from "./sqlite-worker-contract.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";
import type { WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

const runtime = vi.hoisted(() => ({
  mainThread: true,
  environment: new Map<unknown, unknown>(),
  selectedPath: undefined as string | undefined,
  launches: 0,
  pools: new Set<{ close: () => Promise<void> }>(),
  dlopen: vi.fn(),
  select: vi.fn<(path: string) => void>(),
  closeProbe: vi.fn(),
  getEnvironmentData: vi.fn<(key: unknown) => unknown>(),
  setEnvironmentData: vi.fn<(key: unknown, value: unknown) => void>(),
}));

vi.mock("./bun-sqlite-close-probe.js", () => ({ probeSqliteNativeClose: runtime.closeProbe }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (...args: Parameters<typeof actual.createRequire>) => {
    const require = actual.createRequire(...args);
    return Object.assign((specifier: string) => {
      if (specifier === "bun:ffi") {
        return { dlopen: runtime.dlopen, FFIType: { cstring: 0, i32: 1 } };
      }
      if (specifier === "bun:sqlite") {
        return { Database: { setCustomSQLite: runtime.select } };
      }
      return require(specifier);
    }, require);
  };
  return new Proxy(actual, {
    get: (target, property, receiver) =>
      property === "createRequire" ? createRequire : Reflect.get(target, property, receiver),
  });
});

// Bun is simulated through process metadata, but these SQLite workers are real
// Node workers: keep Node's TypeScript loader for their source carriers.
vi.mock("./runtime-worker-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-worker-url.js")>();
  return {
    ...actual,
    runtimeNeedsTypeScriptLoader: (modulePath: string) =>
      actual.runtimeNeedsTypeScriptLoader(modulePath, "node"),
    resolveRuntimeWorkerThreadExecArgv: (url: URL) =>
      actual.resolveRuntimeWorkerThreadExecArgv(url, "node"),
  };
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    get isMainThread() {
      return runtime.mainThread;
    },
    getEnvironmentData: runtime.getEnvironmentData,
    setEnvironmentData: runtime.setEnvironmentData,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        runtime.launches += 1;
        if (!runtime.selectedPath || runtime.environment.size === 0) {
          throw new Error("Worker started before its SQLite library owner completed selection");
        }
        super(...args);
      }
    },
  };
});

vi.mock("./worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worker-task-pool.js")>();
  return {
    ...actual,
    WorkerTaskPool: class<Input, Output> extends actual.WorkerTaskPool<Input, Output> {
      constructor(options: WorkerTaskPoolOptions<Output>) {
        super(options);
        runtime.pools.add(this);
      }
    },
  };
});

const selectionKey = Symbol.for("openclaw.bunSqliteLibrarySelection");
const stores = new Set<SqliteWorkerStore<FixtureOperations>>();
let previousSelection: PropertyDescriptor | undefined;
let previousVersions: PropertyDescriptor | undefined;
let previousPlatform: PropertyDescriptor | undefined;

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

function setRuntime(bun: boolean, platform: string) {
  Object.defineProperty(process, "versions", {
    configurable: true,
    value: { ...process.versions, bun: bun ? "fixture" : undefined },
  });
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(() => {
  previousSelection = Object.getOwnPropertyDescriptor(globalThis, selectionKey);
  previousVersions = Object.getOwnPropertyDescriptor(process, "versions");
  previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Reflect.deleteProperty(globalThis, selectionKey);
  vi.resetModules();
  runtime.mainThread = true;
  runtime.environment.clear();
  runtime.selectedPath = undefined;
  runtime.launches = 0;
  runtime.closeProbe.mockReset().mockResolvedValue({
    explicitSqliteCloseReleasesNativeResources: false,
    reason: "fixture native handles require exit",
  });
  runtime.dlopen.mockReset().mockImplementation(() => ({
    symbols: {
      sqlite3_libversion: () => "3.53.4",
      sqlite3_compileoption_used: () => 0,
    },
    close() {},
  }));
  runtime.select.mockReset().mockImplementation((selectedPath) => {
    if (runtime.selectedPath) {
      throw new Error("SQLite library selection is process-wide and cannot repeat");
    }
    runtime.selectedPath = selectedPath;
  });
  runtime.getEnvironmentData
    .mockReset()
    .mockImplementation((key) => structuredClone(runtime.environment.get(key)));
  runtime.setEnvironmentData.mockReset().mockImplementation((key, value) => {
    runtime.environment.set(key, value);
  });
  vi.stubEnv("OPENCLAW_SQLITE_LIBRARY", "/fixture/sqlite.dylib");
  setRuntime(true, "darwin");
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([
        ...[...stores].map((store) => store.close()),
        ...[...runtime.pools].map((pool) => pool.close()),
      ]);
    } finally {
      stores.clear();
      runtime.pools.clear();
      restoreProperty(globalThis, selectionKey, previousSelection);
      restoreProperty(process, "versions", previousVersions);
      restoreProperty(process, "platform", previousPlatform);
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      runtime.environment.clear();
      cleanup();
    }
  }),
);

async function enterWorkerHeap() {
  runtime.mainThread = false;
  Reflect.deleteProperty(globalThis, selectionKey);
  vi.resetModules();
  return await import("./bun-sqlite-library.js");
}

async function openStore(databasePath: string, broker?: SqliteWorkerBroker) {
  const { openSqliteWorkerStore } = await import("./sqlite-worker-store.js");
  const options = {
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath,
    input: undefined,
  };
  const store = broker
    ? await broker.open<FixtureOperations>(options)
    : await openSqliteWorkerStore<FixtureOperations>(options);
  if (!store) {
    throw new Error("Expected a fixture SQLite store");
  }
  stores.add(store);
  return store;
}

describe("Bun SQLite process selection and worker inheritance", () => {
  it("extends a callable library owner retained from an earlier runtime generation", async () => {
    const retained = vi.fn(() => ({ source: "runtime" as const }));
    Object.defineProperty(globalThis, selectionKey, { configurable: true, value: retained });
    runtime.closeProbe.mockResolvedValue({
      explicitSqliteCloseReleasesNativeResources: true,
      reason: "fixture close passed",
    });
    const owner = await import("./bun-sqlite-library.js");
    expect(owner.ensureSqliteLibrarySelected()).toEqual(retained());
    const admission = owner.initializeSqliteRuntimeCapabilities();
    expect(owner.initializeSqliteRuntimeCapabilities()).toBe(admission);
    expect(await admission).toMatchObject({ explicitSqliteCloseReleasesNativeResources: true });
    expect(Reflect.get(globalThis, selectionKey)).toBe(retained);
    expect(retained()).toEqual({ source: "runtime" });
    expect(runtime.closeProbe).toHaveBeenCalledOnce();
    expect(runtime.select).not.toHaveBeenCalled();
  });

  it.each(["sqlite-target", "model-context", "session-entry", "branch-summaries"] as const)(
    "prepares SQLite before a cold %s read without creating an absent store",
    async (kind) => {
      const directory = tempDirs.make("bun-session-worker-selection-");
      const stateDir = path.join(directory, "state");
      const storePath = path.join(directory, "absent.sqlite");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const target = {
        agentId: "main",
        sessionKey: "agent:main:cold-selection",
        sessionId: "cold-selection",
        storePath,
      };
      const reader = await import("../config/sessions/session-transcript-read-worker-runtime.js");
      switch (kind) {
        case "sqlite-target": {
          const { prepareSqliteTranscriptReadScope } =
            await import("../config/sessions/session-accessor.sqlite-scope.js");
          expect(await prepareSqliteTranscriptReadScope(target)).toMatchObject({
            agentId: target.agentId,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            path: storePath,
          });
          break;
        }
        case "model-context":
          expect(await reader.readSessionTranscriptModelContextInWorker(target, undefined)).toEqual(
            {
              events: [],
            },
          );
          break;
        case "session-entry": {
          const { buildSessionEntry } =
            await import("../../packages/memory-host-sdk/src/host/session-files.js");
          expect(await buildSessionEntry(path.join(directory, "transcript.jsonl"), target)).toBe(
            null,
          );
          break;
        }
        case "branch-summaries": {
          const { runSessionBranchSummaryWorkerRequest } =
            await import("../config/sessions/session-transcript-worker-runtime.js");
          expect(
            await runSessionBranchSummaryWorkerRequest(
              {
                database: { agentId: target.agentId, path: storePath },
                databaseIdentity: "absent-database",
                sessionKey: target.sessionKey,
                sessionId: target.sessionId,
              },
              new AbortController().signal,
            ),
          ).toEqual({ status: "missing-session" });
          break;
        }
      }
      expect(runtime.launches).toBeGreaterThan(0);
      expect(runtime.selectedPath).toBe("/fixture/sqlite.dylib");
      expect(existsSync(storePath)).toBe(false);
      expect(existsSync(stateDir)).toBe(false);
    },
  );

  it("inherits the parent's custom selection without probing or applying a worker override", async () => {
    const parent = await import("./bun-sqlite-library.js");
    const selected = parent.ensureSqliteLibrarySelected();
    expect(selected).toMatchObject({
      source: "env",
      path: "/fixture/sqlite.dylib",
      version: "3.53.4",
    });
    expect([...runtime.environment.values()]).toEqual([selected]);
    const worker = await enterWorkerHeap();
    expect(worker.ensureSqliteLibrarySelected({ explicitPath: "/worker/different.dylib" })).toEqual(
      selected,
    );
    expect(worker.ensureSqliteLibrarySelected()).toEqual(selected);
    expect(runtime.select).toHaveBeenCalledExactlyOnceWith("/fixture/sqlite.dylib");
    expect(runtime.dlopen).toHaveBeenCalledTimes(1);
    expect(runtime.setEnvironmentData).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "inherits the immutable native-close decision (capable: %s)",
    async (capable) => {
      runtime.closeProbe.mockResolvedValue({
        explicitSqliteCloseReleasesNativeResources: capable,
        reason: "parent probe result",
      });
      const parent = await import("./bun-sqlite-library.js");
      const decision = await parent.initializeSqliteRuntimeCapabilities();
      expect(runtime.environment.get("openclaw.sqliteRuntimeCapabilities")).toBe(decision);
      expect(Object.isFrozen(decision)).toBe(true);
      const worker = await enterWorkerHeap();
      expect(worker.getSqliteRuntimeCapabilities()).toEqual(decision);
      expect(await worker.initializeSqliteRuntimeCapabilities()).toEqual(decision);
      expect(Object.isFrozen(worker.getSqliteRuntimeCapabilities())).toBe(true);
      expect(runtime.closeProbe).toHaveBeenCalledOnce();
      expect(runtime.select).toHaveBeenCalledExactlyOnceWith("/fixture/sqlite.dylib");
    },
  );

  it("refreshes inherited facts for new children of a carrier that predates admission", async () => {
    const owner = await import("./bun-sqlite-library.js");
    owner.ensureSqliteLibrarySelected();
    runtime.closeProbe.mockResolvedValue({
      explicitSqliteCloseReleasesNativeResources: true,
      reason: "parent probe result",
    });
    const { captureRetainedNativeWorkerSource } = await import("./worker-native-lifecycle.js");
    let closeSource: Parameters<RuntimeWorkerGeneration["retain"]>[1] | undefined;
    const source = captureRetainedNativeWorkerSource({
      runtimeGeneration: {
        resolve: (url) => url,
        retain: (_owner, close) => {
          closeSource = close;
        },
      },
    });
    const children: RetainedNativeWorker[] = [];
    source.retain({}, async () => {
      await Promise.all(children.map((child) => child.terminate()));
    });
    const spawn = () => {
      const child = source.create(
        `
        const { parentPort, getEnvironmentData } = require("node:worker_threads");
        parentPort.on("message", () => parentPort.postMessage({
          library: getEnvironmentData("openclaw.bunSqliteLibrarySelection"),
          capabilities: getEnvironmentData("openclaw.sqliteRuntimeCapabilities"),
        }));
      `,
        { eval: true, execArgv: [] },
      );
      children.push(child);
      return child;
    };
    const read = async (child: RetainedNativeWorker) => {
      const reply = createDeferredCore<unknown>();
      child.on("message", reply.resolve);
      child.on("error", reply.reject);
      child.postMessage(undefined, []);
      return reply.promise;
    };
    try {
      const early = spawn();
      expect(await read(early)).toMatchObject({
        library: { source: "env", path: "/fixture/sqlite.dylib" },
        capabilities: { explicitSqliteCloseReleasesNativeResources: false },
      });
      await owner.initializeSqliteRuntimeCapabilities();
      const late = spawn();
      expect(await read(late)).toMatchObject({
        capabilities: { explicitSqliteCloseReleasesNativeResources: true },
      });
      expect(await read(early)).toMatchObject({
        capabilities: { explicitSqliteCloseReleasesNativeResources: false },
      });
      expect(runtime.launches).toBe(1);
    } finally {
      const retire = await closeSource?.();
      if (retire) {
        await retire();
      }
    }
  });

  it.each([
    { bun: false, platform: "darwin" },
    { bun: true, platform: "linux" },
  ])(
    "leaves library-selection facts and native selection untouched on $platform (Bun: $bun)",
    async ({ bun, platform }) => {
      setRuntime(bun, platform);
      runtime.getEnvironmentData.mockImplementation((key) => {
        if (key === SQLITE_DATABASE_ADMISSIONS_KEY) {
          return undefined;
        }
        throw new Error("Unrelated worker data must not be read");
      });
      const worker = await enterWorkerHeap();
      expect(worker.ensureSqliteLibrarySelected()).toMatchObject({ source: "runtime" });
      expect(runtime.getEnvironmentData).not.toHaveBeenCalledWith(
        "openclaw.bunSqliteLibrarySelection",
      );
      expect(runtime.getEnvironmentData).not.toHaveBeenCalledWith(
        "openclaw.sqliteRuntimeCapabilities",
      );
      expect(runtime.setEnvironmentData).not.toHaveBeenCalled();
      expect(runtime.dlopen).not.toHaveBeenCalled();
      expect(runtime.select).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "freezes placement and close policy at broker construction (admitted: %s)",
    async (capable) => {
      runtime.closeProbe.mockResolvedValue({
        explicitSqliteCloseReleasesNativeResources: true,
        reason: "fixture native close",
      });
      const owner = await import("./bun-sqlite-library.js");
      const { SqliteWorkerBroker } = await import("./sqlite-worker-broker.js");
      if (capable) {
        await owner.initializeSqliteRuntimeCapabilities();
      }
      const broker = new SqliteWorkerBroker();
      await owner.initializeSqliteRuntimeCapabilities();
      expect(owner.getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources).toBe(
        true,
      );
      const open = (pathname: string) => openStore(pathname, broker);
      const directory = tempDirs.make("bun-sqlite-worker-selection-");
      const paths = Array.from({ length: 5 }, (_, index) =>
        path.join(directory, `${index}.sqlite`),
      );
      const active: SqliteWorkerStore<FixtureOperations>[] = [];
      for (let index = 0; index < paths.length; index += 1) {
        const store = await open(paths[index]!);
        active.push(store);
        await store.execute({ type: "append", input: { value: `database ${index}` } });
      }
      expect(runtime.launches).toBe(capable ? 4 : 5);
      for (const [index, store] of active.entries()) {
        expect(await store.execute({ type: "read", input: undefined })).toEqual([
          `database ${index}`,
        ]);
      }
      const aliasPath = path.join(directory, "alias.sqlite");
      await fs.link(paths[0]!, aliasPath);
      const alias = await open(aliasPath);
      await alias.execute({ type: "append", input: { value: "shared alias" } });
      expect(runtime.launches).toBe(capable ? 4 : 5);
      await active[0]!.close();
      expect(await alias.execute({ type: "read", input: undefined })).toEqual([
        "database 0",
        "shared alias",
      ]);

      if (capable) {
        await alias.close();
        const reopened = await open(paths[0]!);
        expect(await reopened.execute({ type: "read", input: undefined })).toEqual([
          "database 0",
          "shared alias",
        ]);
        expect(runtime.launches).toBe(4);
        expect(
          await active[4]!.execute({ type: "append", input: { value: "sibling still open" } }),
        ).toMatchObject({ writes: 2 });
        return;
      }

      const terminating = createDeferredCore();
      const release = createDeferredCore();
      const termination = vi
        .spyOn(Worker.prototype, "terminate")
        .mockImplementationOnce(async function (this: Worker) {
          terminating.resolve();
          await release.promise;
          termination.mockRestore();
          return this.terminate();
        });
      const closing = alias.close();
      let reopening: Promise<SqliteWorkerStore<FixtureOperations>> | undefined;
      try {
        await terminating.promise;
        const actualFs =
          await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const backendPath = await fs.realpath(
          fileURLToPath(new URL("./sqlite-worker-store.test-support.ts", import.meta.url)),
        );
        const inspected = createDeferredCore();
        vi.mocked(fs.stat).mockImplementation(async (pathname, options) => {
          const result = await actualFs.stat(pathname, options);
          if (pathname === backendPath) {
            inspected.resolve();
          }
          return result;
        });
        let reopenSettled = false;
        reopening = open(paths[0]!);
        void reopening.then(
          () => {
            reopenSettled = true;
          },
          () => {
            reopenSettled = true;
          },
        );
        await inspected.promise;
        await Promise.resolve();
        expect(runtime.launches).toBe(5);
        expect(reopenSettled).toBe(false);
        vi.mocked(fs.stat).mockImplementation(actualFs.stat);
        release.resolve();
        await closing;
        const reopened = await reopening;
        expect(await reopened.execute({ type: "read", input: undefined })).toEqual([
          "database 0",
          "shared alias",
        ]);
        expect(runtime.launches).toBe(6);
        expect(await active[1]!.execute({ type: "read", input: undefined })).toEqual([
          "database 1",
        ]);
        expect(await active[4]!.execute({ type: "read", input: undefined })).toEqual([
          "database 4",
        ]);
      } finally {
        release.resolve();
        termination.mockRestore();
        const actualFs =
          await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        vi.mocked(fs.stat).mockImplementation(actualFs.stat);
        await Promise.allSettled([closing, ...(reopening ? [reopening] : [])]);
      }
      expect(runtime.select).toHaveBeenCalledExactlyOnceWith("/fixture/sqlite.dylib");
      expect(
        runtime.setEnvironmentData.mock.calls.filter(([key]) =>
          ["openclaw.bunSqliteLibrarySelection", "openclaw.sqliteRuntimeCapabilities"].includes(
            String(key),
          ),
        ),
      ).toHaveLength(2);
    },
  );

  it("publishes no successful selection and starts no worker after the native hook fails", async () => {
    runtime.select.mockImplementation(() => {
      throw new Error("Native selection failed");
    });
    const databasePath = path.join(tempDirs.make("bun-sqlite-selection-failure-"), "store.sqlite");
    await expect(openStore(databasePath)).rejects.toThrow("Native selection failed");
    const { ensureSqliteLibrarySelected } = await import("./bun-sqlite-library.js");
    expect(() => ensureSqliteLibrarySelected()).toThrow("Native selection failed");
    expect(runtime.select).toHaveBeenCalledTimes(1);
    expect(runtime.environment.size).toBe(0);
    expect(runtime.setEnvironmentData).not.toHaveBeenCalled();
    expect(runtime.launches).toBe(0);
    expect(existsSync(databasePath)).toBe(false);
  });
});
