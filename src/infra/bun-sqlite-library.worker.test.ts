import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { SqliteWorkerStore } from "./sqlite-worker-contract.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

const runtime = vi.hoisted(() => ({
  mainThread: true,
  environment: new Map<unknown, unknown>(),
  selectedPath: undefined as string | undefined,
  launches: 0,
  dlopen: vi.fn(),
  select: vi.fn<(path: string) => void>(),
  getEnvironmentData: vi.fn<(key: unknown) => unknown>(),
  setEnvironmentData: vi.fn<(key: unknown, value: unknown) => void>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
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
    },
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
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
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

async function openStore(databasePath: string) {
  const { openSqliteWorkerStore } = await import("./sqlite-worker-store.js");
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath,
    input: undefined,
  });
  stores.add(store);
  return store;
}

describe("Bun SQLite process selection and worker inheritance", () => {
  it("inherits the completed custom selection without repeating Bun's one-shot native hook", async () => {
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

  it("inherits the parent's runtime fallback without independently probing or applying an override", async () => {
    vi.stubEnv("OPENCLAW_SQLITE_LIBRARY", "");
    runtime.dlopen.mockImplementation(() => {
      throw new Error("No custom library available");
    });
    const parent = await import("./bun-sqlite-library.js");
    expect(parent.ensureSqliteLibrarySelected()).toEqual({ source: "runtime" });
    expect([...runtime.environment.values()]).toEqual([{ source: "runtime" }]);
    runtime.dlopen.mockClear();
    const worker = await enterWorkerHeap();
    expect(worker.ensureSqliteLibrarySelected({ explicitPath: "/worker/different.dylib" })).toEqual(
      { source: "runtime" },
    );
    expect(runtime.dlopen).not.toHaveBeenCalled();
    expect(runtime.select).not.toHaveBeenCalled();
  });

  it.each([
    { bun: false, platform: "darwin" },
    { bun: true, platform: "linux" },
  ])(
    "leaves worker environment facts and native selection untouched on $platform (Bun: $bun)",
    async ({ bun, platform }) => {
      setRuntime(bun, platform);
      runtime.getEnvironmentData.mockImplementation(() => {
        throw new Error("Unrelated worker data must not be read");
      });
      const worker = await enterWorkerHeap();
      expect(worker.ensureSqliteLibrarySelected()).toMatchObject({ source: "runtime" });
      expect(runtime.getEnvironmentData).not.toHaveBeenCalled();
      expect(runtime.setEnvironmentData).not.toHaveBeenCalled();
      expect(runtime.dlopen).not.toHaveBeenCalled();
      expect(runtime.select).not.toHaveBeenCalled();
    },
  );

  it("prepares dedicated workers, bounds distinct databases, and retains ownership until termination joins", async () => {
    const directory = tempDirs.make("bun-sqlite-worker-selection-");
    const paths = Array.from({ length: 5 }, (_, index) => path.join(directory, `${index}.sqlite`));
    const active: SqliteWorkerStore<FixtureOperations>[] = [];
    for (let index = 0; index < 4; index += 1) {
      const store = await openStore(paths[index]!);
      active.push(store);
      await store.execute({ type: "append", input: { value: `database ${index}` } });
    }
    const [overflow] = await Promise.allSettled([openStore(paths[4]!)]);
    if (overflow.status === "fulfilled") {
      await overflow.value.close();
    }
    expect(overflow).toMatchObject({ status: "rejected", reason: { code: "overloaded" } });
    expect(existsSync(paths[4]!)).toBe(false);
    expect(runtime.launches).toBe(4);
    for (const [index, store] of active.entries()) {
      expect(await store.execute({ type: "read", input: undefined })).toEqual([
        `database ${index}`,
      ]);
    }
    const aliasPath = path.join(directory, "alias.sqlite");
    await fs.link(paths[0]!, aliasPath);
    const alias = await openStore(aliasPath);
    await alias.execute({ type: "append", input: { value: "shared alias" } });
    expect(runtime.launches).toBe(4);
    await active[0]!.close();
    expect(await alias.execute({ type: "read", input: undefined })).toEqual([
      "database 0",
      "shared alias",
    ]);

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
      // Leave room for a replacement so the database owner, not the worker cap, must block it.
      await active[3]!.close();
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
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
      reopening = openStore(paths[0]!);
      void reopening.then(
        () => {
          reopenSettled = true;
        },
        () => {
          reopenSettled = true;
        },
      );
      await inspected.promise;
      // Resume the admission continuation after its last filesystem inspection.
      await Promise.resolve();
      expect(runtime.launches).toBe(4);
      expect(reopenSettled).toBe(false);
      vi.mocked(fs.stat).mockImplementation(actualFs.stat);
      release.resolve();
      await closing;
      const reopened = await reopening;
      expect(await reopened.execute({ type: "read", input: undefined })).toEqual([
        "database 0",
        "shared alias",
      ]);
      expect(runtime.launches).toBe(5);
      expect(await active[1]!.execute({ type: "read", input: undefined })).toEqual(["database 1"]);
      expect(await active[2]!.execute({ type: "read", input: undefined })).toEqual(["database 2"]);
    } finally {
      release.resolve();
      termination.mockRestore();
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fs.stat).mockImplementation(actualFs.stat);
      await Promise.allSettled([closing, ...(reopening ? [reopening] : [])]);
    }
    expect(runtime.select).toHaveBeenCalledExactlyOnceWith("/fixture/sqlite.dylib");
    expect(runtime.setEnvironmentData).toHaveBeenCalledTimes(1);
  });

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
