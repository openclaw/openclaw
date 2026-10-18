import type { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import type {
  WorkerTaskOptions,
  WorkerTaskPoolOptions,
} from "../../infra/worker-task-pool.types.js";

type Resource = { close: () => Promise<void>; agentId?: string; revoke: () => void };
type PostedUsageTask = { input?: unknown; taskId?: number; responseId?: number };
type NativeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(message: PostedUsageTask) => void>>;
};
const nativeWorkers = vi.hoisted(() => [] as NativeWorker[]);
const nativePosts = vi.hoisted(() => ({
  observe: undefined as ((worker: NativeWorker, message: PostedUsageTask) => void) | undefined,
}));
const observed = vi.hoisted(() => ({
  preparedDatabase: true,
  serializePools: false,
  queued: vi.fn<(busy: boolean) => void>(),
  explicitSqliteCloseReleasesNativeResources: true,
  setTimeout: vi.spyOn(globalThis, "setTimeout"),
  clearTimeout: vi.spyOn(globalThis, "clearTimeout"),
  run: vi.fn<(input: unknown, options: WorkerTaskOptions<unknown>) => Promise<unknown>>(),
  // Import-time pools are drained even when a name filter skips every test.
  rotate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  closeResources: vi.fn<(key?: string) => Promise<void>>().mockResolvedValue(undefined),
  unregister: vi.fn<() => void>(),
  resources: [] as Resource[],
}));

vi.mock("../../infra/worker-task-capacity.js", async (importOriginal) => {
  const { createWorkerComputeCapacity } = await import("@openclaw/worker-runtime");
  const capacity = createWorkerComputeCapacity(1);
  return {
    ...(await importOriginal<typeof import("../../infra/worker-task-capacity.js")>()),
    getWorkerComputeCapacity: () => capacity,
  };
});
vi.mock("../../infra/runtime-worker-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/runtime-worker-url.js")>()),
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor() {
        super();
        nativeWorkers.push(this);
      }
      postMessage = vi.fn<(message: PostedUsageTask) => void>((message) =>
        nativePosts.observe?.(this, message),
      );
      ref() {}
      unref() {}
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});

// Transport controls model settled native preparation and its published format facts;
// cold-admission regressions exercise the real writer queue before either exists.
vi.mock("../../infra/sqlite-database-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-database-admission.js")>()),
  hasSqliteDatabaseSchemaAdmissionForPath: () => observed.preparedDatabase,
}));

vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>()),
  captureExistingOpenClawAgentDatabaseExecution: (options: { path: string }) => {
    if (!observed.preparedDatabase) {
      return undefined;
    }
    const claim = { identity: "transport", incarnation: "transport", assertCurrent() {} };
    return {
      agentId: "main",
      path: options.path,
      fileIdentity: undefined,
      assertCurrent() {},
      captureGenerationClaim: () => claim,
      capturePreparedGenerationClaim: () => claim,
      async prepare() {
        throw new Error("Readonly transport must not prepare a writer");
      },
      async runExisting() {
        throw new Error("Readonly transport must not open a writer");
      },
      async release() {},
    };
  },
}));

vi.mock("../../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: () => ({ source: "runtime" }),
  captureSqliteWorkerClosePolicy: () => observed.explicitSqliteCloseReleasesNativeResources,
  getSqliteRuntimeCapabilities: () => ({
    explicitSqliteCloseReleasesNativeResources: observed.explicitSqliteCloseReleasesNativeResources,
    reason: "test policy",
  }),
}));

vi.mock("node:diagnostics_channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:diagnostics_channel")>();
  const pressure = actual.channel(Symbol("session-transcript-worker-lanes"));
  return {
    ...actual,
    channel: (name: string | symbol) =>
      name === "openclaw.memory.critical" ? pressure : actual.channel(name),
  };
});

vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: (poolOptions: WorkerTaskPoolOptions<unknown>) => {
    let worker: ReturnType<NonNullable<typeof poolOptions.prepareWorker>> | undefined;
    const retiring = new Set<NonNullable<typeof worker>>();
    let activeTasks = 0;
    const serialSlots = Array.from({ length: poolOptions.maxWorkers ?? 1 }, () =>
      Promise.resolve(),
    );
    let nextSlot = 0;
    return {
      async run(prepare: () => unknown, options: WorkerTaskOptions<unknown>) {
        const execute = async () => {
          activeTasks++;
          try {
            const preparedInput = prepare();
            worker ??= poolOptions.prepareWorker?.();
            return await observed.run(preparedInput, options);
          } finally {
            activeTasks--;
          }
        };
        if (!observed.serializePools) {
          return execute();
        }
        observed.queued(activeTasks >= serialSlots.length);
        const index = nextSlot++ % serialSlots.length;
        const result = serialSlots[index]!.then(execute);
        serialSlots[index] = result.then(
          () => {},
          () => {},
        );
        return result;
      },
      getSnapshot: () => ({ activeTasks }),
      async rotate() {
        if (worker) {
          retiring.add(worker);
        }
        worker = undefined;
        const previous = [...retiring];
        try {
          await observed.rotate();
          for (const prepared of previous) {
            if (retiring.delete(prepared)) {
              await prepared.releaseResources?.();
            }
          }
        } catch (error) {
          void Promise.resolve(poolOptions.onRetirementFailure?.(error)).catch(() => undefined);
          throw error;
        }
      },
      closeResources: observed.closeResources,
    };
  },
}));
// mock-isolation: Observe custody without registering real database lifecycle resources.
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  matchesAgentDatabaseReadCandidatePath: (candidate: { path: string }, targetPath: string) =>
    candidate.path === targetPath,
  registerOpenClawAgentDatabaseReadCandidateResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
  registerOpenClawAgentDatabaseAsyncResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
}));
// The pure transport must not become the process-wide disk-scan singleton.
// mock-isolation: Reader controls must never start the process-wide disk scanner.
vi.mock("./disk-budget-runtime.js", () => ({
  measureSessionPhysicalDiskUsage: () => {
    throw new Error("Disk scans are forbidden in these pure controls");
  },
  drainSessionDiskBudgetWorkers: async () => {},
}));

import {
  historyLane,
  maintenanceLane,
  projectionLane,
  rotateDatabaseWorkers,
  targetDiscoveryLane,
} from "./session-transcript-worker-resources.js";

let sequence = 0;
function input() {
  const database = { agentId: "main", path: `/synthetic/session-read-lanes-${++sequence}.sqlite` };
  return {
    database,
    scope: {
      agentId: "main",
      databaseAgentId: "main",
      sessionKey: "agent:main:lanes",
      storePath: database.path,
    },
  };
}

beforeEach(() => {
  observed.preparedDatabase = true;
  observed.serializePools = false;
  observed.queued.mockReset();
  observed.explicitSqliteCloseReleasesNativeResources = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  observed.setTimeout.mockImplementation(globalThis.setTimeout);
  observed.clearTimeout.mockImplementation(globalThis.clearTimeout);
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.closeResources.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  observed.closeResources.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  await Promise.all(
    [historyLane, projectionLane, maintenanceLane, targetDiscoveryLane].map((lane) =>
      rotateDatabaseWorkers(lane),
    ),
  );
});
afterAll(() => {
  vi.useRealTimers();
  observed.setTimeout.mockRestore();
  observed.clearTimeout.mockRestore();
});

export { input, nativePosts, nativeWorkers, observed };
export type { NativeWorker };
