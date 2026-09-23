import { serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { sqliteWriteAdmissionServicesForLocation } from "./sqlite-transaction-core.js";
import { dispatchSqliteWorkerJob } from "./sqlite-worker-broker-reply.js";
import type { Actor, Job, Slot } from "./sqlite-worker-broker.types.js";
import { resolveStateDatabaseCoordinatorPath } from "./state-database-coordinator.js";

const edge = vi.hoisted(() => ({
  forbidden: vi.fn((): never => {
    throw new Error("Lifecycle location proof crossed a native or process boundary");
  }),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class {
      postMessage = vi.fn();
    },
  };
});
vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:child_process", () => ({
  spawn: edge.forbidden,
  spawnSync: edge.forbidden,
  execFile: edge.forbidden,
  execFileSync: edge.forbidden,
  fork: edge.forbidden,
}));

afterEach(() => {
  expect(edge.forbidden).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

it.each(["execute", "close"] as const)(
  "services agent worker %s preparation at the shared-state coordinator location until settlement",
  (operation) => {
    const statePath = "/synthetic/state/openclaw.sqlite";
    const agentPath = "/synthetic/agents/main/agent.sqlite";
    const runtimeDirectory = "/synthetic/coordinators";
    const job: Job = {
      request: {
        id: 1,
        actor: 1,
        ...(operation === "execute"
          ? {
              type: "execute" as const,
              input: serialize({ type: "database.prepareWrite", input: undefined }),
            }
          : { type: "close" as const }),
      },
      ...(operation === "execute" ? { requireStateLifecycle: true } : {}),
      bytes: 0,
      resolve: edge.forbidden,
      reject: edge.forbidden,
      detach() {},
    };
    const slot: Slot = {
      worker: new Worker(new URL("file:///synthetic/sqlite-store.worker.js")),
      receiveReply: edge.forbidden,
      actors: new Set(),
      queue: [],
      current: job,
      exit: Promise.resolve(),
      exited: false,
      pendingOpens: 0,
    };
    const actor: Actor = {
      id: 1,
      key: "file:agent",
      databasePath: agentPath,
      stateDatabasePath: statePath,
      pathReferences: new Map([[agentPath, 1]]),
      moduleUrl: "file:///synthetic/openclaw-agent-execution.worker.js",
      inputHash: "fixture",
      slot,
      references: 1,
      opened: Promise.resolve(),
      openDispatch: { dispatched: true },
      initialized: true,
      backendClosed: false,
      stateContext: {
        environment: { OPENCLAW_STATE_DIR: "/synthetic" },
        coordinatorRuntime: { directory: runtimeDirectory, keepAlive: false },
      },
      pendingStateLifecycles: new Set(),
      nativeStopped: Promise.resolve(),
      markNativeStopped() {},
    };
    slot.actors.add(actor);
    const coordinatorPath = (databasePath: string) =>
      resolveStateDatabaseCoordinatorPath({
        databasePath,
        runtimeDirectory,
        uid: process.getuid?.(),
      });
    const sharedCoordinator = coordinatorPath(statePath);
    const agentCoordinator = coordinatorPath(agentPath);
    const reject = vi.fn();
    try {
      dispatchSqliteWorkerJob(slot, job, reject);
      expect(reject).not.toHaveBeenCalled();
      expect(sqliteWriteAdmissionServicesForLocation(sharedCoordinator)?.size).toBe(1);
      expect(sqliteWriteAdmissionServicesForLocation(agentCoordinator)).toBeUndefined();
    } finally {
      job.lifecyclePreparation?.finish();
    }
    expect(sqliteWriteAdmissionServicesForLocation(sharedCoordinator)).toBeUndefined();
  },
);
