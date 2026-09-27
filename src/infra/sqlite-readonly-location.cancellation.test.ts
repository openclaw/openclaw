import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import * as workerUrls from "./runtime-worker-url.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "./sqlite-snapshot-source.js";

const processMocks = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  processMocks.execFile.mockImplementation(actual.execFile);
  Object.defineProperty(
    processMocks.execFile,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return {
    ...actual,
    execFile: processMocks.execFile,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const reclamationChildren: Promise<ChildProcess>[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    try {
      for (const child of await Promise.all(reclamationChildren)) {
        expect(child.exitCode).toBe(0);
        expect(child.signalCode).toBeNull();
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      cleanup();
    }
  });
});
let cacheRoot: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  reclamationChildren.length = 0;
  processMocks.execFile.mockReset().mockImplementation((file, args, options, callback) => {
    const child = actual.execFile(file, args, options, callback);
    if (isWorkerMode(args, "reclaim")) {
      reclamationChildren.push(
        new Promise<ChildProcess>((resolve) => {
          child.once("close", () => resolve(child));
        }),
      );
    }
    return child;
  });
  vi.mocked(spawn).mockClear();
  vi.mocked(spawnSync).mockClear();
  cacheRoot = tempDirs.make("openclaw-readonly-cancellation-cache-");
  vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
});

const reclaimFixture = `
  if (process.argv[3] === "reclaim") {
    process.stdout.write(JSON.stringify({ ok: true, warnings: [] }));
    process.exit(0);
  }
`;

function isWorkerMode(args: readonly string[] | null | undefined, mode: string): boolean {
  const marker = args?.indexOf(SQLITE_READONLY_CHILD_ARG) ?? -1;
  return marker >= 0 && args?.[marker + 1] === mode;
}

function inspectionChild(mode: "session" | "async") {
  const mock = mode === "session" ? vi.mocked(spawn) : processMocks.execFile;
  const index = mock.mock.calls.findIndex(([, args]) => isWorkerMode(args, mode));
  return mock.mock.results[index]?.value;
}

function createDatabase(): string {
  const pathname = path.join(tempDirs.make("openclaw-readonly-cancellation-"), "source.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('preserved');");
  database.close();
  return pathname;
}

describe("SQLite read-only worker cancellation", () => {
  it("joins an idle child that ignores graceful shutdown after its bounded fallback", async () => {
    const fixture = tempDirs.make("openclaw-readonly-idle-close-");
    const worker = path.join(fixture, "worker.mjs");
    fs.writeFileSync(
      worker,
      `
      import fs from "node:fs"; import path from "node:path";
      ${reclaimFixture}
      process.on("message", (message) => {
        if (typeof message === "object") {
          const location = path.join(message.args[2], "snapshot.sqlite");
          fs.writeFileSync(location, "");
          process.send({ id: message.id, result: { ok: true, location } });
        }
      });
      setTimeout(() => process.exit(2), 35000);
    `,
    );
    vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
    let inspectionFinished = false;
    const schedule = globalThis.setTimeout;
    const shutdownTimeouts: Array<number | undefined> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (inspectionFinished) {
        shutdownTimeouts.push(delay);
      }
      return schedule(callback, inspectionFinished && delay === 300_000 ? 1 : delay, ...args);
    });
    await withSqliteReadOnlyWorkerScope(async () => {
      const prepared = await prepareSqliteReadOnlyLocation(path.join(fixture, "unused.sqlite"), {
        preserveSourceArtifacts: true,
      });
      expect(await prepared.cleanupAsync()).toBe(true);
      inspectionFinished = true;
    });
    expect(shutdownTimeouts).toEqual([300_000]);
    expect(inspectionChild("session")?.signalCode).toBe("SIGKILL");
    expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
  });

  it.each(
    [true, false].flatMap((preserveSourceArtifacts) =>
      (["abort", "scope-close", "invalid-response", "signal-exit"] as const).map((stop) => ({
        preserveSourceArtifacts,
        stop,
      })),
    ),
  )(
    "joins a scoped child and removes its unpublished snapshot on $stop (raw=$preserveSourceArtifacts)",
    async ({ stop, preserveSourceArtifacts }) => {
      const fixture = tempDirs.make("openclaw-readonly-scoped-held-");
      const worker = path.join(fixture, "worker.mjs");
      const ready = path.join(fixture, "ready");
      fs.writeFileSync(
        worker,
        `
        import fs from "node:fs";
        import path from "node:path";
        ${reclaimFixture}
        process.on("SIGTERM", () => {});
        const block = (stagingRoot, id) => {
          fs.writeFileSync(path.join(stagingRoot, "partial.sqlite"), "private partial snapshot");
          fs.writeFileSync(${JSON.stringify(ready)}, stagingRoot);
          ${
            stop === "invalid-response"
              ? `
            if (id === undefined) {
              process.stdout.write(JSON.stringify({ ok: true, unexpected: "invalid" }));
              process.exit(0);
            } else {
              process.send({ id, result: { ok: true, unexpected: "invalid" } });
            }`
              : ""
          }
        };
        if (process.argv[3] === "session") {
          process.on("message", ({ id, args }) => block(args[2], id));
        } else {
          block(process.argv[5]);
        }
        setTimeout(() => process.exit(2), 5000);
      `,
      );
      vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
      const controller = new AbortController();
      const reason = new Error("startup stopped");
      let operation: Promise<unknown> | undefined;
      try {
        await withSqliteReadOnlyWorkerScope(async () => {
          operation = prepareSqliteReadOnlyLocation(path.join(fixture, "unused.sqlite"), {
            signal: controller.signal,
            preserveSourceArtifacts,
          });
          void operation.catch(() => {});
          await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
          if (stop === "abort") {
            controller.abort(reason);
            await expect(operation).rejects.toBe(reason);
          } else if (stop === "signal-exit") {
            await waitForSignalExitBarriers();
            await expect(operation).rejects.toThrow(/snapshot owner stopped|SIGKILL/);
          } else if (stop === "invalid-response") {
            await expect(operation).rejects.toThrow("returned an invalid result");
          }
        });
        const child = inspectionChild(preserveSourceArtifacts ? "session" : "async");
        if (!preserveSourceArtifacts && stop === "invalid-response") {
          expect(child.exitCode).toBe(0);
        } else {
          expect(child.signalCode).toBe("SIGKILL");
        }
        if (stop === "scope-close") {
          await expect(operation).rejects.toThrow("scope closed");
        }
        expect(fs.existsSync(fs.readFileSync(ready, "utf8"))).toBe(false);
        expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
      } finally {
        controller.abort(reason);
        await Promise.allSettled([operation]);
      }
    },
  );

  it("rejects stopped ownership before staging or spawning", async () => {
    const controller = new AbortController();
    const reason = new Error("startup stopped");
    controller.abort(reason);
    await expect(
      prepareSqliteReadOnlyLocation(path.join(cacheRoot, "unused.sqlite"), {
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
         ${reclaimFixture}
         fs.writeFileSync(path.join(process.argv[5], 'partial.sqlite'), 'private partial snapshot');
         process.on('SIGTERM', () => {});
         setTimeout(() => process.exit(2), 5000);`,
    );
    vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
    const controller = new AbortController();
    const reason = new Error("startup stopped");
    const operation = prepareSqliteReadOnlyLocation(path.join(fixture, "unused.sqlite"), {
      signal: controller.signal,
    });
    let childClosed: Promise<void> | undefined;
    try {
      const workerIndex = () =>
        processMocks.execFile.mock.calls.findIndex(([, args]) => isWorkerMode(args, "async"));
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
  it.each(["sync", "async", "scoped"] as const)(
    "bounds the %s child and removes its unpublished copy",
    async (mode) => {
      const root = tempDirs.make("openclaw-snapshot-timeout-");
      vi.stubEnv("XDG_CACHE_HOME", root);
      const worker = path.join(root, "blocked.mjs");
      const ready = path.join(root, "ready");
      fs.writeFileSync(
        worker,
        `import fs from 'node:fs'; import path from 'node:path';
      ${reclaimFixture}
      process.on('SIGTERM', () => {});
      const block = (stagingRoot) => {
        fs.writeFileSync(path.join(stagingRoot, 'partial.sqlite'), 'partial');
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      };
      if (process.argv[3] === 'session') {
        process.on('message', ({ args }) => block(args[2]));
      } else {
        block(process.argv[5]);
      }
      setTimeout(() => process.exit(0), 35000);`,
      );
      vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
      const source = path.join(root, "source.sqlite");
      fs.writeFileSync(source, "source must stay unchanged");
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const executeFile = processMocks.execFile.getMockImplementation()!;
      let childClosed: Promise<void> | undefined;
      let closeSignal: NodeJS.Signals | null | undefined;
      // Exercise native termination and cleanup without waiting out the production budget.
      if (mode === "scoped") {
        const schedule = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
          schedule(
            callback,
            delay === 301_000 && inspectionChild("session") ? 2_000 : delay,
            ...args,
          ),
        );
      } else if (mode === "sync") {
        vi.mocked(spawnSync).mockImplementationOnce((command, args, options) => {
          expect(options).toMatchObject({ timeout: 301_000, killSignal: "SIGKILL" });
          const result = actual.spawnSync(command, args, { ...options, timeout: 2_000 });
          expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
          closeSignal = result.signal;
          return result;
        });
      } else {
        processMocks.execFile.mockImplementation((file, args, options, callback) => {
          if (!isWorkerMode(args, mode)) {
            return executeFile(file, args, options, callback);
          }
          expect(options).toMatchObject({ timeout: 301_000, killSignal: "SIGKILL" });
          const child = executeFile(file, args, { ...options, timeout: 2_000 }, callback);
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
          : mode === "scoped"
            ? withSqliteReadOnlyWorkerScope(() =>
                prepareSqliteReadOnlyLocation(source, { preserveSourceArtifacts: true }),
              )
            : prepareSqliteReadOnlyLocation(source);
      try {
        await expect(
          run().finally(() => {
            // Check at settlement, before the finally block joins for failed-test cleanup.
            expect(mode === "scoped" ? inspectionChild("session")?.signalCode : closeSignal).toBe(
              "SIGKILL",
            );
          }),
        ).rejects.toThrow(
          /timed out after 301 seconds \(budget for 26 B\).*Stop the Gateway service/,
        );
        expect(performance.now() - started).toBeLessThan(8_000);
        expect(fs.readFileSync(ready, "utf8")).toBe("ready");
        expect(fs.readFileSync(source, "utf8")).toBe("source must stay unchanged");
        expect(fs.readdirSync(path.join(root, "openclaw"))).toEqual([]);
      } finally {
        await childClosed;
        processMocks.execFile.mockReset().mockImplementation(executeFile);
        vi.mocked(spawnSync).mockReset().mockImplementation(actual.spawnSync);
      }
    },
    10_000,
  );
});
