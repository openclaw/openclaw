import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as workerUrls from "./runtime-worker-url.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "./sqlite-readonly-location.js";
import { SQLITE_READONLY_CHILD_ARG } from "./sqlite-readonly-worker.js";

const processMocks = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  processMocks.execFile.mockImplementation(actual.execFile);
  Object.defineProperties(processMocks.execFile, Object.getOwnPropertyDescriptors(actual.execFile));
  return { ...actual, execFile: processMocks.execFile, spawnSync: vi.fn(actual.spawnSync) };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
let cacheRoot: string;
beforeEach(() => {
  processMocks.execFile.mockClear();
  vi.mocked(spawnSync).mockClear();
  cacheRoot = tempDirs.make("openclaw-readonly-cancellation-cache-");
  vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
});

function createDatabase(): string {
  const pathname = path.join(tempDirs.make("openclaw-readonly-cancellation-"), "source.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('preserved');");
  database.close();
  return pathname;
}

describe("SQLite read-only worker cancellation", () => {
  it("rejects stopped ownership before staging or spawning", async () => {
    const controller = new AbortController();
    const reason = new Error("startup stopped");
    controller.abort(reason);
    await expect(
      prepareSqliteReadOnlyLocation(path.join(cacheRoot, "unused.sqlite"), {
        preserveSourceArtifacts: true,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(processMocks.execFile).not.toHaveBeenCalled();
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  it("joins a killed child before rejecting and removes its unpublished partial snapshot", async () => {
    const fixture = tempDirs.make("openclaw-readonly-held-worker-");
    const worker = path.join(fixture, "worker.mjs");
    fs.writeFileSync(
      worker,
      `import fs from 'node:fs'; import path from 'node:path';
         fs.writeFileSync(path.join(process.argv[5], 'partial.sqlite'), 'private partial snapshot');
         process.on('SIGTERM', () => {});
         setTimeout(() => process.exit(2), 5000);`,
    );
    vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
    const controller = new AbortController();
    const reason = new Error("startup stopped");
    const operation = prepareSqliteReadOnlyLocation(path.join(fixture, "unused.sqlite"), {
      preserveSourceArtifacts: true,
      signal: controller.signal,
    });
    let childClosed: Promise<void> | undefined;
    try {
      const workerIndex = () =>
        processMocks.execFile.mock.calls.findIndex(
          (call) => Array.isArray(call[1]) && call[1].includes(SQLITE_READONLY_CHILD_ARG),
        );
      await vi.waitFor(() => expect(workerIndex()).toBeGreaterThanOrEqual(0));
      const callIndex = workerIndex();
      const child = processMocks.execFile.mock.results[callIndex]?.value;
      expect(child).toBeDefined();
      childClosed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const argv = processMocks.execFile.mock.calls[callIndex]?.[1];
      if (!Array.isArray(argv)) {
        throw new Error("worker arguments missing");
      }
      const stagingRoot = argv.at(-1)!;
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(stagingRoot, "partial.sqlite"))).toBe(true),
      );
      controller.abort(reason);
      await expect(operation).rejects.toBe(reason);
      await childClosed;
      expect(child.signalCode).toBe("SIGKILL");
      expect(fs.existsSync(stagingRoot)).toBe(false);
      expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
    } finally {
      controller.abort(reason);
      await Promise.allSettled([operation, childClosed]);
    }
  });

  it("reports failed owned cleanup and keeps it retryable", async () => {
    const source = createDatabase();
    const before = fs.readFileSync(source);
    const prepared = await prepareSqliteReadOnlyLocation(source, {
      preserveSourceArtifacts: true,
      signal: new AbortController().signal,
    });
    const remove = fs.rmSync;
    const failure = Object.assign(new Error("private snapshot busy"), { code: "EBUSY" });
    const stub = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => prepared.cleanup()).toThrow("snapshot cleanup failed");
      expect(fs.existsSync(prepared.location)).toBe(true);
    } finally {
      stub.mockImplementation(remove);
      expect(prepared.cleanup()).toBe(true);
    }
    expect(fs.readFileSync(source)).toEqual(before);
    expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
  });
});

describe("read-only snapshot deadline", () => {
  it.each(["sync", "async"] as const)(
    "bounds the %s child and removes its unpublished copy",
    async (mode) => {
      const root = tempDirs.make("openclaw-snapshot-timeout-");
      vi.stubEnv("XDG_CACHE_HOME", root);
      const worker = path.join(root, "blocked.mjs");
      const ready = path.join(root, "ready");
      fs.writeFileSync(
        worker,
        `import fs from 'node:fs'; import path from 'node:path';
      process.on('SIGTERM', () => {});
      fs.writeFileSync(path.join(process.argv[5], 'partial.sqlite'), 'partial');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setTimeout(() => process.exit(0), 35000);`,
      );
      vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
      const source = path.join(root, "source.sqlite");
      fs.writeFileSync(source, "source must stay unchanged");
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      let childClosed: Promise<void> | undefined;
      let closeSignal: NodeJS.Signals | null | undefined;
      // Exercise native termination and cleanup without waiting out the production budget.
      if (mode === "sync") {
        vi.mocked(spawnSync).mockImplementationOnce((command, args, options) => {
          expect(options).toMatchObject({ timeout: 31_000, killSignal: "SIGKILL" });
          const result = actual.spawnSync(command, args, { ...options, timeout: 2_000 });
          expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
          closeSignal = result.signal;
          return result;
        });
      } else {
        processMocks.execFile.mockImplementationOnce((file, args, options, callback) => {
          expect(options).toMatchObject({ timeout: 31_000, killSignal: "SIGKILL" });
          const child = actual.execFile(file, args, { ...options, timeout: 2_000 }, callback);
          childClosed = new Promise<void>((resolve) => {
            child.once("close", (_code, signal) => {
              closeSignal = signal;
              resolve();
            });
          });
          return child;
        });
      }
      const started = performance.now();
      const run = async () =>
        mode === "sync"
          ? prepareSqliteReadOnlyLocationSync(source)
          : prepareSqliteReadOnlyLocation(source);
      try {
        await expect(
          run().finally(() => {
            // Check at settlement, before the finally block joins for failed-test cleanup.
            expect(closeSignal).toBe("SIGKILL");
          }),
        ).rejects.toThrow(
          /timed out after 31 seconds \(budget for 26 B\).*Stop the Gateway service/,
        );
        expect(performance.now() - started).toBeLessThan(8_000);
        expect(fs.readFileSync(ready, "utf8")).toBe("ready");
        expect(fs.readFileSync(source, "utf8")).toBe("source must stay unchanged");
        expect(fs.readdirSync(path.join(root, "openclaw"))).toEqual([]);
      } finally {
        await childClosed;
        // execFile's copied prototype must not become its own parent during reset.
        processMocks.execFile.mockReset().mockImplementation(actual.execFile.bind(undefined));
        vi.mocked(spawnSync).mockReset().mockImplementation(actual.spawnSync);
      }
    },
    10_000,
  );
});
