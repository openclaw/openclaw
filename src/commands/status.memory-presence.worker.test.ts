import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildMemoryIndexStrictSchema } from "../../packages/memory-host-sdk/src/host/memory-schema-base.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchManager,
  createStatusScanSharedMocks,
  loadStatusScanModuleForTest,
} from "./status.scan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      const pools = [...(poolRun?.pools ?? [])];
      await Promise.all(pools.map((pool) => pool.rotate()));
      for (const pool of pools) {
        expect(pool.isClosed).toBe(false);
        expect(pool.getSnapshot()).toMatchObject({ workers: 0, activeTasks: 0, pendingTasks: 0 });
      }
      cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  }),
);
const mocks = {
  ...createStatusScanSharedMocks("memory-presence-worker"),
  callGateway: vi.fn(async () => null),
  resolveMemorySearchConfig: vi.fn(),
};
const writeJson = vi.fn<(value: unknown, space?: number) => void>();
const runtime: OutputRuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeStdout: vi.fn(),
  writeJson,
};
let statusJsonCommand: typeof import("./status-json.js").statusJsonCommand;
let sqliteOwner: typeof import("../infra/node-sqlite.js");
let poolRun: Awaited<ReturnType<typeof observeWorkerPools>> | undefined;

async function observeWorkerPools() {
  const { resolveBundledPublicSurfaceLocation } = await import("../plugin-sdk/facade-loader.js");
  const { getCachedPluginModuleLoader } = await import("../plugins/plugin-module-loader-cache.js");
  const { preparePluginLoaderAliases } = await import("../plugins/sdk-alias.js");
  const location = resolveBundledPublicSurfaceLocation({
    dirName: "memory-core",
    artifactBasename: "status-api.js",
    preferSource: false,
  });
  if (!location) {
    throw new Error("Memory status artifact was not resolved");
  }
  // The public artifact uses its native module graph, outside Vitest's module cache.
  const facadeUrl = new URL("../plugin-sdk/facade-loader.ts", import.meta.url).href;
  const loader = getCachedPluginModuleLoader({
    modulePath: location.modulePath,
    importerUrl: facadeUrl,
    loaderFilename: facadeUrl,
    preferBuiltDist: true,
  });
  const sdkPath = preparePluginLoaderAliases({
    modulePath: location.modulePath,
    moduleUrl: facadeUrl,
    argv1: process.argv[1],
  }).resolveAlias("openclaw/plugin-sdk/process-runtime");
  if (!sdkPath) {
    throw new Error("Memory worker SDK was not resolved");
  }
  const { WorkerTaskPool } = loader(sdkPath) as typeof import("../plugin-sdk/process-runtime.js");
  type Pool = InstanceType<typeof WorkerTaskPool>;
  const pools = new Set<Pool>();
  let nextFailure: Error | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- Every intercepted call supplies the actual pool receiver via apply.
  const originalRun = WorkerTaskPool.prototype.run;
  const run = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
    this: Pool,
    ...args: Parameters<typeof originalRun>
  ) {
    pools.add(this);
    if (nextFailure) {
      const failure = nextFailure;
      nextFailure = undefined;
      return Promise.reject(failure);
    }
    return originalRun.apply(this, args);
  });
  return {
    run,
    pools,
    rejectNextInspection(error: Error) {
      nextFailure = error;
    },
  };
}

beforeAll(async () => {
  applyStatusScanDefaults(mocks);
  await loadStatusScanModuleForTest(mocks, { fastJson: true });
  vi.doMock("../gateway/connection-details.js", async () => ({
    ...(await vi.importActual<typeof import("../gateway/connection-details.js")>(
      "../gateway/connection-details.js",
    )),
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetails,
  }));
  vi.doMock("./status-runtime-shared.ts", () => ({
    resolveStatusRuntimeSnapshot: async () => ({
      gatewayService: { label: "test-service", installed: false },
      nodeService: { label: "test-service", installed: false },
    }),
  }));
  vi.doMock("../state/backup-run-records.js", () => ({
    readBackupRunFreshness: async () => ({}),
  }));
  vi.doMock("../infra/update-run-status.js", () => ({ readUpdateRunStatus: () => ({}) }));
  vi.resetModules();
  ({ statusJsonCommand } = await import("./status-json.js"));
  sqliteOwner = await import("../infra/node-sqlite.js");
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockClear();
  }
  writeJson.mockClear();
  const memoryManager = createStatusMemorySearchManager();
  memoryManager.manager.status.mockReturnValue({ files: 1, chunks: 0, dirty: false });
  applyStatusScanDefaults(mocks, { memoryManager });
});

afterAll(async () => {
  poolRun?.run.mockRestore();
  const { resetFacadeLoaderStateForTest } = await import("../plugin-sdk/facade-loader.js");
  const { waitForPluginCacheRetirement } = await import("../plugins/plugin-cache.js");
  resetFacadeLoaderStateForTest();
  await waitForPluginCacheRetirement();
});

it.each(["populated", "empty", "unrelated", "missing", "unavailable"] as const)(
  "keeps offline JSON-all %s memory presence off the caller's SQLite thread",
  async (kind) => {
    const stateDir = tempDirs.make("openclaw-status-memory-presence-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const { resolveDefaultMemoryDatabasePath } = await import("./status.scan-memory.js");
    const databasePath = resolveDefaultMemoryDatabasePath("main");
    if (kind !== "missing") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(
          kind === "unrelated"
            ? "CREATE TABLE unrelated_feature (id INTEGER PRIMARY KEY) STRICT"
            : buildMemoryIndexStrictSchema({
                embeddingCacheTable: "memory_embedding_cache",
                includeEmbeddingCache: false,
              }),
        );
        if (kind === "populated" || kind === "unavailable") {
          database.exec(
            "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES ('MEMORY.md', 'memory', 'synthetic', 1, 10)",
          );
        }
      } finally {
        database.close();
      }
    }
    const before = kind === "missing" ? undefined : fs.readFileSync(databasePath);
    mocks.resolveMemorySearchConfig.mockReturnValue({ store: { databasePath } });
    const observer = (poolRun ??= await observeWorkerPools());
    if (kind === "unavailable") {
      // Exercise dispatch rejection without creating a failed native worker.
      observer.rejectNextInspection(new Error("Synthetic inspection unavailable"));
    }
    const nativeCalls = [
      vi.spyOn(sqliteOwner, "openNodeSqliteDatabase"),
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      vi.spyOn(DatabaseSync.prototype, "close"),
      vi.spyOn(StatementSync.prototype, "all"),
      vi.spyOn(StatementSync.prototype, "get"),
      vi.spyOn(StatementSync.prototype, "run"),
    ];
    try {
      const samples = [];
      for (let attempt = 0; attempt < (kind === "populated" ? 4 : 1); attempt++) {
        writeJson.mockClear();
        mocks.getMemorySearchManager.mockClear();
        observer.run.mockClear();
        for (const call of nativeCalls) {
          call.mockClear();
        }
        const started = performance.now();
        await statusJsonCommand({ all: true }, runtime);
        const durationMs = performance.now() - started;
        if (kind === "missing") {
          expect(observer.run).not.toHaveBeenCalled();
        } else {
          expect(observer.run).toHaveBeenCalled();
          expect(observer.pools.size).toBeGreaterThan(0);
        }
        expect(writeJson).toHaveBeenCalledOnce();
        expect(writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            gateway: expect.objectContaining({ reachable: false }),
            memory:
              kind === "populated" ? { agentId: "main", files: 1, chunks: 0, dirty: false } : null,
          }),
          2,
        );
        expect(mocks.getMemorySearchManager).toHaveBeenCalledTimes(kind === "populated" ? 1 : 0);
        const parentSqlCalls = nativeCalls.map((call) => call.mock.calls.length);
        expect(parentSqlCalls).toEqual([0, 0, 0, 0, 0, 0, 0]);
        samples.push({ attempt, durationMs, parentSqlCalls });
      }
      console.info(
        JSON.stringify({
          fixture: kind,
          timingScope: "handler after same-loader SDK observer setup",
          samples,
          json: writeJson.mock.calls[0]?.[0],
        }),
      );
      if (before) {
        expect(fs.readFileSync(databasePath)).toEqual(before);
      } else {
        expect(fs.existsSync(databasePath)).toBe(false);
      }
    } finally {
      for (const call of nativeCalls) {
        call.mockRestore();
      }
    }
  },
);
