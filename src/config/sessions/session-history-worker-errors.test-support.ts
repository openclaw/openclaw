import { vi } from "vitest";
import type { WorkerTaskOptions } from "../../infra/worker-task-pool.types.js";
import type { SessionTranscriptDisplayDeltaResult } from "./session-accessor.sqlite-history-query.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";

type Request = {
  input: unknown;
  taskId: number;
  interactive?: boolean;
  nativeSections: SharedArrayBuffer;
};
type Resource = { close: () => Promise<void>; agentId?: string; revoke: () => void };
type QuarantineDatabase = {
  isOpen: boolean;
  exec: () => void;
  prepare: () => { get: () => unknown };
  close: () => void;
};
const observed = vi.hoisted(() => ({
  handler: undefined as ((input: unknown) => unknown) | undefined,
  receive: undefined as ((message: Request) => void) | undefined,
  post: vi.fn<(message: unknown) => void>(),
  read: vi.fn<() => unknown>(),
  delta: vi.fn<() => SessionTranscriptDisplayDeltaResult>(),
  lookup: vi.fn<() => boolean>(),
  close: vi.fn<() => void>(),
  run: vi.fn<(input: unknown, options: WorkerTaskOptions<unknown>) => Promise<unknown>>(),
  closeResources: vi.fn<(key?: string) => Promise<void>>(),
  deferredRun: undefined as
    | ((prepare: () => unknown, options: { inputBytes?: number }) => Promise<unknown>)
    | undefined,
  quarantineRead: vi.fn<() => unknown>(),
  quarantineClose: vi.fn<() => void>(),
  quarantineOpen: vi.fn<() => QuarantineDatabase>(),
  quarantinePaths: new Set<string>(),
  hydrate: vi.fn<() => unknown>(),
  rotate: vi.fn<() => Promise<void>>(),
  unregister: vi.fn<() => void>(),
  resources: [] as Resource[],
  nativeWorker: vi.fn(() => {
    throw new Error("Native workers are forbidden in these pure controls");
  }),
}));

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: observed.nativeWorker,
  parentPort: {
    on: (_event: string, receive: (message: Request) => void) => {
      observed.receive = receive;
    },
    postMessage: (message: unknown) => observed.post(message),
  },
}));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/session-history.worker.mjs"),
  resolveRuntimeWorkerArgv: () => [],
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-pool.js")>();
  return {
    ...actual,
    createOwnedWorkerTaskPool: () => ({
      run(prepare: () => unknown, options: WorkerTaskOptions<unknown>) {
        if (observed.deferredRun) {
          return observed.deferredRun(prepare, options);
        }
        return observed.run(prepare(), options);
      },
      rotate: observed.rotate,
      closeResources: observed.closeResources,
    }),
    WorkerTaskPool: class {
      run(prepare: () => unknown, options: WorkerTaskOptions<unknown>) {
        return observed.run(prepare(), options);
      }
      rotate() {
        return observed.rotate();
      }
    },
  };
});
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-server.js")>();
  return {
    ...actual,
    serveOwnedWorkerTasks: (handler: (input: unknown) => unknown) => {
      observed.handler = handler;
      actual.serveOwnedWorkerTasks(handler);
    },
  };
});
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
vi.mock("../../state/openclaw-agent-db-readonly-scope.js", () => ({
  closeOpenClawAgentDatabaseReadOnlyCandidates: vi.fn(),
  OpenClawAgentDatabaseReadOnlyScope: class {
    hasRetainedConnection = true;
    run(_database: unknown, operation: () => unknown) {
      return operation();
    }
    close() {
      observed.close();
    }
  },
}));
vi.mock("../../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) =>
      observed.quarantinePaths.has(args[0])
        ? observed.quarantineOpen()
        : actual.openNodeSqliteDatabase(...args),
  };
});
// Keep the history fixture's fake pool out of the process-wide disk-scan singleton.
vi.mock("./disk-budget-runtime.js", () => ({
  measureSessionPhysicalDiskUsage: () => {
    throw new Error("Disk scans are forbidden in these pure controls");
  },
  drainSessionDiskBudgetWorkers: async () => {},
}));
vi.mock("./session-transcript-hydration.worker.js", () => ({
  streamSessionTranscriptHydration: observed.hydrate,
}));
vi.mock("./session-accessor.sqlite-entry.js", () => ({
  loadSessionEntryReadOnlyInScope: () => observed.read(),
}));
vi.mock("./session-sharing-store.js", () => ({
  listSessionMembers: () => {
    throw new Error("Native membership reads are forbidden in these pure controls");
  },
}));
vi.mock("../../gateway/session-history-readonly-reader.js", () => ({
  createReadonlySessionHistoryReader: () => ({
    readTranscriptDisplayDelta: observed.delta,
    subagentCoordination: {
      isSubagentSession: observed.lookup,
      isSubagentRunMessage: observed.lookup,
    },
  }),
}));
vi.mock("./session-cold-storage-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-cold-storage-read.js")>();
  return {
    ...actual,
    readRestoredSessionTranscript: (
      ...args: Parameters<typeof actual.readRestoredSessionTranscript>
    ) =>
      args[0].sessionId === "delta" ? args[1]() : actual.readRestoredSessionTranscript(...args),
  };
});

export const typedFailures = [
  {
    error: new SessionTranscriptColdError("cold-session"),
    reply: { kind: "cold", sessionId: "cold-session" },
  },
  {
    error: new SessionTranscriptProjectionUnavailableError("projected-session"),
    reply: { kind: "projection", sessionId: "projected-session" },
  },
  {
    error: new SessionTranscriptReadFenceError("fence failed"),
    reply: { kind: "fence", message: "fence failed" },
  },
];

export function createVisibilityFailureDelta(
  resetFirst: boolean,
): SessionTranscriptDisplayDeltaResult {
  const mirror = {
    role: "assistant",
    provider: "openclaw",
    model: "delivery-mirror",
    content: "Mirror",
    openclawDeliveryMirror: { kind: "channel-final", sourceAssistantMessageId: "before-cursor" },
  };
  const coordination = {
    role: "user",
    content: "Internal coordination",
    provenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: "agent:main:acp:source",
    },
  };
  return {
    kind: "page",
    cursor: "cursor",
    activeLeafEntryId: "message-1",
    hasMore: false,
    serializedBytes: 512,
    events: (resetFirst ? [mirror, coordination] : [coordination, mirror]).map(
      (message, index) => ({
        seq: index + 1,
        messageSeq: index + 1,
        event: { type: "message", id: `message-${index}`, message },
      }),
    ),
  };
}

export { observed };
