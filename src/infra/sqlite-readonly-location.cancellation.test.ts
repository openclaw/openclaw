import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
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
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { mockChildProcesses } = await import("./sqlite-readonly.test-support.js");
  return mockChildProcesses(actual, processMocks.execFile);
});

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts?.close());

async function fixtureReadyBeforeSettlement(ready: string, operation: Promise<unknown>) {
  const check = (error: unknown) => {
    if (!fs.existsSync(ready)) {
      throw error;
    }
  };
  const settled = operation.then(() => {
    check(new Error(`Snapshot worker settled before staging ready: ${ready}`));
  }, check);
  await Promise.race([receipts.waitFor(ready, "ready"), settled]);
}

const reclamationChildren: Promise<ChildProcess>[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    try {
      for (const child of await Promise.all(reclamationChildren)) {
        expect(child).toMatchObject({ exitCode: 0, signalCode: null });
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
      reclamationChildren.push(once(child, "close").then(() => child));
    }
    return child;
  });
  vi.mocked(spawn).mockClear();
  vi.mocked(spawnSync).mockReset().mockImplementation(actual.spawnSync);
  cacheRoot = tempDirs.make("openclaw-readonly-cancellation-cache-");
  vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
});

function installWorker(
  reply: "hold" | "valid" | "invalid",
  { watchdog = 5000, exitCode = 2, receipt = reply !== "valid" } = {},
) {
  const root = tempDirs.make("openclaw-readonly-worker-");
  const worker = path.join(root, "worker.mjs");
  const ready = path.join(root, "ready");
  fs.writeFileSync(
    worker,
    `
        import fs from "node:fs";
        import path from "node:path";
        ${receipt ? fixtureReceiptClientSource(receipts.endpoint) : ""}
        if (process.argv[3] === "reclaim") {
          process.stdout.write(JSON.stringify({ ok: true, warnings: [] }));
          process.exit(0);
        }
        const reply = ${JSON.stringify(reply)};
        ${reply === "valid" ? "" : 'process.on("SIGTERM", () => {});'}
        const block = (stagingRoot, id) => {
          const location = path.join(stagingRoot, reply === "valid" ? "snapshot.sqlite" : "partial.sqlite");
          fs.writeFileSync(location, reply === "valid" ? "" : "private partial snapshot");
          if (reply !== "valid") {
            fs.writeFileSync(${JSON.stringify(ready)}, ${receipt ? "stagingRoot" : '"ready"'});
            ${receipt ? `sendReceipt(${JSON.stringify(ready)}, "ready");` : ""}
          }
          if (reply === "hold") return;
          const result = reply === "valid" ? { ok: true, location } : { ok: true, unexpected: "invalid" };
          if (id === undefined) {
            process.stdout.write(JSON.stringify(result));
            process.exit(0);
          } else {
            process.send({ id, result });
          }
        };
        if (process.argv[3] === "session") {
          process.on("message", (message) => {
          if (reply !== "valid" || typeof message === "object") block(message.args[2], message.id);
          });
        } else {
          block(process.argv[5]);
        }
        setTimeout(() => process.exit(${exitCode}), ${watchdog});
      `,
  );
  vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(worker));
  return { root, ready, source: path.join(root, "unused.sqlite") };
}

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

it("joins an idle child that ignores graceful shutdown after its bounded fallback", async () => {
  const { source } = installWorker("valid", { watchdog: 35000 });
  let inspectionFinished = false;
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
    schedule(callback, inspectionFinished && delay === 300_000 ? 1 : delay, ...args),
  );
  await withSqliteReadOnlyWorkerScope(async () => {
    const prepared = await prepareSqliteReadOnlyLocation(source, {
      preserveSourceArtifacts: true,
    });
    expect(await prepared.cleanupAsync()).toBe(true);
    inspectionFinished = true;
  });
  expect(inspectionChild("session")?.signalCode).toBe("SIGKILL");
  expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
});

it.for([
  { raw: true, stop: "abort" },
  { raw: true, stop: "scope-close" },
  { raw: true, stop: "invalid-response" },
  { raw: false, stop: "abort" },
  { raw: false, stop: "invalid-response" },
  { raw: false, stop: "signal-exit" },
] as const)(
  "joins a child and removes its unpublished snapshot on $stop (raw=$raw)",
  async ({ stop, raw }, { signal }) => {
    const { source, ready } = installWorker(stop === "invalid-response" ? "invalid" : "hold");
    const controller = new AbortController();
    const reason = new Error("startup stopped");
    let operation: Promise<unknown> | undefined;
    try {
      await withSqliteReadOnlyWorkerScope(async () => {
        operation = prepareSqliteReadOnlyLocation(source, {
          signal: controller.signal,
          preserveSourceArtifacts: raw,
        });
        void operation.catch(() => {});
        await withinTest(fixtureReadyBeforeSettlement(ready, operation), signal);
        if (stop === "abort") {
          const child = inspectionChild(raw ? "session" : "async");
          expect(child).toBeDefined();
          const closed = once(child, "close");
          expect(fs.existsSync(path.join(fs.readFileSync(ready, "utf8"), "partial.sqlite"))).toBe(
            true,
          );
          controller.abort(reason);
          await expect(operation).rejects.toBe(reason);
          await closed;
        } else if (stop === "signal-exit") {
          await waitForSignalExitBarriers();
          await expect(operation).rejects.toThrow(/snapshot owner stopped|SIGKILL/);
        } else if (stop === "invalid-response") {
          await expect(operation).rejects.toThrow("returned an invalid result");
        }
      });
      const child = inspectionChild(raw ? "session" : "async");
      if (!raw && stop === "invalid-response") {
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
it.each(["sync", "async", "scoped"] as const)(
  "bounds the %s child and removes its unpublished copy",
  async (mode) => {
    const { root, source, ready } = installWorker("hold", {
      watchdog: 35000,
      exitCode: 0,
      receipt: false,
    });
    vi.stubEnv("XDG_CACHE_HOME", root);
    fs.writeFileSync(source, "source must stay unchanged");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
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
        childClosed = once(child, "close").then(([, signal]) => {
          closeSignal = signal;
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
    }
  },
  10_000,
);
