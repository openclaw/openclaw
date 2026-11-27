import type * as ChildProcessModule from "node:child_process";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MessagePort, WorkerOptions } from "node:worker_threads";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { withWorkerPreload } from "../../test/helpers/runtime-preload.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as processUrls from "../infra/runtime-process-url.js";
import {
  readSqliteDatabaseCleanClose,
  readSqliteDatabaseIntegrityVerification,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { configureSqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type * as WorkerCpuModule from "../infra/worker-cpu.js";
import type * as NativeWorkerModule from "../infra/worker-native-lifecycle.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import { verifyAgentDatabaseStartupIntegrity } from "./agent-database-startup-verification.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-contract.js";
import { createNativeIntegritySource } from "./openclaw-agent-execution-native.test-support.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "./openclaw-agent-execution.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";

const nativeTicks = vi.hoisted(() => ({
  pathname: "",
  ports: new Set<MessagePort>(),
  ready: Promise.withResolvers<MessagePort>(),
  ticked: Promise.withResolvers<void>(),
  checkpoint: Promise.withResolvers<{
    result: { busy: number; log: number; checkpointed: number };
    walBytes: number;
    databaseBytes: number;
  }>(),
}));

function withNativeTickPreload(filename: string | URL, options: WorkerOptions = {}): WorkerOptions {
  const url = filename instanceof URL ? filename : pathToFileURL(filename);
  const extension = path.extname(fileURLToPath(url));
  const { port1, port2 } = new MessageChannel();
  nativeTicks.ports.add(port1);
  port1.once("close", () => {
    nativeTicks.ports.delete(port1);
  });
  port1.on("message", (message) => {
    if (message.type === "native-ready") {
      nativeTicks.ready.resolve(port1);
    }
    if (message.type === "ticked") {
      nativeTicks.ticked.resolve();
    }
    if (message.type === "checkpoint") {
      nativeTicks.checkpoint.resolve(message);
    }
    if (message.type === "fixture-error") {
      const error = new Error(message.message);
      nativeTicks.ready.reject(error);
      nativeTicks.ticked.reject(error);
      nativeTicks.checkpoint.reject(error);
    }
  });
  const preload = `
import fs from "node:fs";
import { createRequire } from "node:module";
import { workerData } from "node:worker_threads";
const { observeSqliteWalPeriodicWork } = await import(workerData.testScheduler);
const sqlite = createRequire(workerData.testScheduler)("node:sqlite");
const NativeDatabase = sqlite.DatabaseSync;
let openedPath;
const targetPath = workerData.testTargetPath;
const port = workerData.testTickPort;
const nativePrepare = NativeDatabase.prototype.prepare;
NativeDatabase.prototype.prepare = function(sql) {
  const statement = nativePrepare.call(this, sql);
  if (this.location() === targetPath && /^PRAGMA wal_checkpoint\\(/i.test(sql)) {
    const get = statement.get.bind(statement);
    statement.get = (...args) => {
      const result = get(...args);
      port.postMessage({
        type: "checkpoint",
        result,
        walBytes: fs.statSync(targetPath + "-wal").size,
        databaseBytes: fs.statSync(targetPath).size,
      });
      return result;
    };
  }
  return statement;
};
sqlite.DatabaseSync = new Proxy(NativeDatabase, {
  construct(target, args) {
    openedPath = args[0];
    return Reflect.construct(target, args);
  },
});
const scheduled = observeSqliteWalPeriodicWork(() => {
  const selected = targetPath && openedPath === targetPath;
  if (selected) port.postMessage({ type: "native-ready" });
  return selected;
}, "tick");
port.on("message", (message) => {
  if (message.type === "tick") {
    try {
      // Dispatch the product's registered 10-second tick, not an explicit maintenance command.
      void scheduled.periodic();
      port.postMessage({ type: "ticked" });
    } catch (error) {
      port.postMessage({ type: "fixture-error", message: error.message });
    }
  }
});
port.once("close", () => {
  NativeDatabase.prototype.prepare = nativePrepare;
  scheduled.restore();
  sqlite.DatabaseSync = NativeDatabase;
});
`;
  const preloaded = withWorkerPreload(options, preload, {
    testScheduler: new URL(`./sqlite-wal-scheduler.test-support${extension}`, url).href,
    testTickPort: port2,
    testTargetPath: nativeTicks.pathname,
  });
  return { ...preloaded, transferList: [...(options.transferList ?? []), port2] };
}

vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerCpuModule>();
  return {
    ...actual,
    createCpuTrackedWorker(...args: Parameters<typeof actual.createCpuTrackedWorker>) {
      const [filename, options, requestClass] = args;
      return actual.createCpuTrackedWorker(
        filename,
        String(filename).includes("sqlite-store.worker")
          ? withNativeTickPreload(filename, options)
          : options,
        requestClass,
      );
    },
  };
});

vi.mock("../infra/worker-native-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NativeWorkerModule>();
  return {
    ...actual,
    createRetainedNativeWorker(...args: Parameters<typeof actual.createRetainedNativeWorker>) {
      const [filename, options, ...rest] = args;
      return actual.createRetainedNativeWorker(
        filename,
        options?.workerData?.sharedWorkerHost ? withNativeTickPreload(filename, options) : options,
        ...rest,
      );
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
const { fork: nativeFork } = await vi.importActual<typeof ChildProcessModule>("node:child_process");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    for (const port of nativeTicks.ports) {
      port.close();
    }
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    cleanup();
  });
});

it("relays a native scheduled checkpoint through an ordinary reply to join only its owned startup scan", async ({
  signal,
}) => {
  const env = {
    OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("startup-native-wal-pressure-")),
  };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
  const scope = { agentId: "main", env, sessionKey: "agent:main:retained" };
  await replaceSessionEntry(scope, { sessionId: "retained", updatedAt: 1 });
  const pathname = openOpenClawAgentDatabase(scope).path;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  revokeSqliteDatabaseAdmissionsForPath(pathname);
  nativeTicks.pathname = pathname;

  const worker = path.join(env.OPENCLAW_STATE_DIR, "held-integrity.mjs");
  fs.writeFileSync(
    worker,
    `import { DatabaseSync } from "node:sqlite";
process.once("message", ({ pathname }) => {
  const database = new DatabaseSync(pathname, { readOnly: true });
  database.exec("BEGIN");
  database.prepare("PRAGMA schema_version").get();
  process.on("message", (message) => {
    if (message.type === "test-probe") {
      // Retain the snapshot's database while the child waits for the next message.
      database.prepare("PRAGMA schema_version").get();
      process.send({ type: "test-alive" });
    }
  });
  process.send({ type: "test-pinned" });
});`,
  );
  const entrypoint = processUrls.resolveRuntimeProcessEntrypointUrl;
  vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockImplementation((name) =>
    name === "sqliteIntegrity" ? pathToFileURL(worker) : entrypoint(name),
  );
  const pinned = Promise.withResolvers<ChildProcessModule.ChildProcess>();
  const closed = Promise.withResolvers<void>();
  let child: ChildProcessModule.ChildProcess | undefined;
  vi.mocked(fork).mockImplementationOnce((...args) => {
    const launched = nativeFork(...args);
    child = launched;
    launched.on("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "test-pinned"
      ) {
        pinned.resolve(launched);
      }
    });
    launched.once("error", pinned.reject);
    launched.once("close", () => {
      closed.resolve();
      pinned.reject(new Error("Integrity child closed before pinning its snapshot"));
    });
    return launched;
  });
  let nativeExecution: OpenClawAgentDatabaseExecution | undefined;
  try {
    await withAgentDatabaseStartupAdmission(async (admission) => {
      const owner = admission.adopt();
      const verifyIntegrity = vi.fn(verifyAgentDatabaseStartupIntegrity);
      admission.activate({
        isCurrent: () => true,
        preparationReady: Promise.resolve(),
        openAgent: async () => {},
        migrateAgent: async () => {},
        publishAgent: async () => {},
        verifyIntegrity,
      });
      try {
        await replaceSessionEntry(scope, { sessionId: "retained", updatedAt: 2 });
        const scan = await withinTest(pinned.promise, signal);
        const native = await captureOpenClawAgentDatabaseExecutionAsync({
          ...scope,
          path: pathname,
        });
        nativeExecution = native;
        const source = createNativeIntegritySource(() => native.assertCurrent());
        await native.runExisting(source, (nativeScope) =>
          nativeScope.execute({
            type: "session.transcript.initialize",
            input: { sessionKey: "agent:main:native-seed", sessionId: "native-seed" },
          }),
        );
        expect(nativeTicks.ports.size).toBeGreaterThan(0);
        const tickPort: MessagePort = await withinTest(nativeTicks.ready.promise, signal);
        using writer = openNodeSqliteDatabase(pathname);
        const maintenance = configureSqliteWalMaintenance(writer, {
          databasePath: pathname,
          autoCheckpointPages: 0,
          checkpointIntervalMs: 0,
        });
        const pass = () =>
          maintenance.maintainPeriodic!({ maxPages: 0, checkpointMode: "PASSIVE" });
        try {
          writer.exec(
            "CREATE TABLE wal_pressure(data BLOB); INSERT INTO wal_pressure VALUES (x'01')",
          );
          pass();
          pass();
          expect(maintenance.health).toMatchObject({ state: "blocked", warning: true });
          expect(scan.killed).toBe(false);
          const unrelatedPath = path.join(env.OPENCLAW_STATE_DIR, "unrelated.sqlite");
          using unrelated = openNodeSqliteDatabase(unrelatedPath);
          const unrelatedMaintenance = configureSqliteWalMaintenance(unrelated, {
            databasePath: unrelatedPath,
            autoCheckpointPages: 0,
            checkpointIntervalMs: 0,
          });
          using reader = openNodeSqliteDatabase(unrelatedPath, { readOnly: true });
          try {
            unrelated.exec("CREATE TABLE payload(data BLOB); PRAGMA wal_checkpoint(TRUNCATE)");
            reader.exec("BEGIN; SELECT * FROM payload");
            unrelated.exec("INSERT INTO payload VALUES (zeroblob(67108864))");
            unrelatedMaintenance.maintainPeriodic!({ maxPages: 0, checkpointMode: "PASSIVE" });
            expect(unrelatedMaintenance.health).toMatchObject({ state: "blocked", warning: true });
            expect(scan.killed).toBe(false);
            const alive = Promise.withResolvers<void>();
            scan.once("message", () => alive.resolve());
            scan.send({ type: "test-probe" });
            await withinTest(alive.promise, signal);
          } finally {
            reader.exec("ROLLBACK");
            await unrelatedMaintenance.stop();
          }

          writer.exec("INSERT INTO wal_pressure VALUES (zeroblob(67108864))");
          expect(fs.statSync(`${pathname}-wal`).size).toBeGreaterThan(
            Math.max(2 * fs.statSync(pathname).size, 64 * 1024 * 1024),
          );
          tickPort.postMessage({ type: "tick" }, []);
          await withinTest(nativeTicks.ticked.promise, signal);
          expect(scan.killed).toBe(false);
          // A normal admitted session write drains the native tick; no explicit WAL command or host publish.
          await native.runExisting(source, (nativeScope) =>
            nativeScope.execute({
              type: "session.transcript.initialize",
              input: { sessionKey: "agent:main:native-drain", sessionId: "native-drain" },
            }),
          );
          const observed = await withinTest(nativeTicks.checkpoint.promise, signal);
          expect(observed.result.log).toBeGreaterThan(observed.result.checkpointed);
          expect(observed.walBytes).toBeGreaterThan(
            Math.max(2 * observed.databaseBytes, 64 * 1024 * 1024),
          );
          // Without the ordinary-reply relay, the real native snapshot is still alive here.
          expect(scan.killed).toBe(true);
          await withinTest(Promise.resolve(admission.pendingPreparation), signal);
          await withinTest(closed.promise, signal);
          expect(scan.signalCode).toBe("SIGKILL");
          expect(readSqliteDatabaseIntegrityVerification(pathname)).toBeUndefined();
          expect(() => assertAgentDatabaseAdmitted("main", { env })).not.toThrow();
          expect(
            readOpenClawDatabaseQuarantineFailure("agent", pathname, { env, fresh: true }),
          ).toBeUndefined();
          pass();
          expect(maintenance.health).toMatchObject({ state: "complete" });
          expect(fs.statSync(`${pathname}-wal`).size).toBe(0);
          expect(verifyIntegrity).toHaveBeenCalledOnce();
        } finally {
          await maintenance.stop();
        }
        await native.release();
        await closeOpenClawAgentDatabasesAsync();
        expect(readSqliteDatabaseCleanClose(pathname)).toBe(false);
      } finally {
        await nativeExecution?.release();
        await owner.stop();
      }
    });
  } finally {
    if (child) {
      await closed.promise;
    }
  }
});
