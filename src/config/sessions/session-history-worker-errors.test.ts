import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions } from "../../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

type Request = {
  input: unknown;
  taskId: number;
  interactive?: boolean;
  nativeSections: SharedArrayBuffer;
};
type Resource = { close: () => Promise<void> };
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
  close: vi.fn<() => void>(),
  run: vi.fn<(input: unknown, options: WorkerTaskOptions<unknown>) => Promise<unknown>>(),
  quarantineRead: vi.fn<() => unknown>(),
  quarantineClose: vi.fn<() => void>(),
  quarantineOpen: vi.fn<() => QuarantineDatabase>(),
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
    serveWorkerTasks: (handler: (input: unknown) => unknown) => {
      observed.handler = handler;
      actual.serveWorkerTasks(handler);
    },
  };
});
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
}));
vi.mock("../../state/openclaw-agent-db-readonly-scope.js", () => ({
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
vi.mock("../../infra/node-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/node-sqlite.js")>()),
  openNodeSqliteDatabase: observed.quarantineOpen,
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

await import("./session-transcript.worker.js");
let sequence = 0;
function input() {
  const database = { agentId: "main", path: `/synthetic/session-read-errors-${++sequence}.sqlite` };
  return {
    kind: "session-row-presence",
    database,
    scope: {
      agentId: "main",
      databaseAgentId: "main",
      sessionKey: "agent:main:errors",
      storePath: database.path,
    },
  };
}
function invoke(request: ReturnType<typeof input>) {
  assert(observed.handler);
  return Promise.resolve(observed.handler(request));
}

function installWorkerTransport() {
  observed.run.mockImplementation(async (request, options) => {
    const posted = createDeferredCore<unknown>();
    observed.post.mockImplementation(posted.resolve);
    assert(observed.receive);
    observed.receive({
      input: request,
      taskId: 7,
      interactive: Boolean(options.onRequest),
      nativeSections: new SharedArrayBuffer(4),
    });
    const reply = await posted.promise;
    assert(reply && typeof reply === "object" && "status" in reply);
    if (reply.status === "failed") {
      assert("error" in reply && typeof reply.error === "string");
      throw new WorkerTaskError(reply.error, "failed");
    }
    assert(reply.status === "ok" && "value" in reply);
    return structuredClone(reply.value);
  });
}

async function readThroughWorker() {
  const request = input();
  installWorkerTransport();
  return await withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  observed.post.mockReset();
  observed.read.mockReset();
  observed.close.mockReset();
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
  observed.quarantineRead.mockReset().mockReturnValue({ user_version: 0 });
  observed.quarantineClose.mockReset();
  observed.quarantineOpen.mockReset().mockImplementation(() => {
    const database: QuarantineDatabase = {
      isOpen: true,
      exec() {},
      prepare: () => ({ get: observed.quarantineRead }),
      close() {
        observed.quarantineClose();
        database.isOpen = false;
      },
    };
    return database;
  });
  observed.hydrate.mockReset().mockReturnValue({
    kind: "full",
    eventCount: 0,
    version: { generation: null, rawSeq: null, updatedAt: null },
  });
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  expect(observed.nativeWorker).not.toHaveBeenCalled();
});

it("preserves the worker read failure through transfer when closing succeeds", async () => {
  const primary = new Error("read failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  await expect(readThroughWorker()).rejects.toMatchObject({ message: primary.message });
  expect(observed.close).toHaveBeenCalledTimes(1);
});

it("retains both worker errors through transfer when the read and close fail", async () => {
  const primary = new Error("read failed");
  const cleanup = new Error("database close failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  observed.close.mockImplementation(() => {
    throw cleanup;
  });
  const failure: unknown = await readThroughWorker().catch((error: unknown) => error);
  assert(failure instanceof AggregateError);
  expect(failure.errors).toMatchObject([
    { message: primary.message },
    { message: cleanup.message },
  ]);
  expect(failure.cause).toBe(failure.errors[1]);
  expect(failure.message).toContain(primary.message);
  expect(failure.message).toContain(cleanup.message);
});

const typedFailures = [
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
it.each(typedFailures)(
  "keeps typed $reply.kind recovery when closing succeeds",
  async ({ error, reply }) => {
    observed.read.mockImplementation(() => {
      throw error;
    });
    await expect(invoke(input())).resolves.toEqual({ ok: false, error: reply });
    expect(observed.close).toHaveBeenCalledTimes(1);
  },
);
it.each(typedFailures)(
  "does not recover typed $reply.kind reads when close also fails",
  async ({ error }) => {
    const cleanup = new Error("close failed");
    observed.read.mockImplementation(() => {
      throw error;
    });
    observed.close.mockImplementation(() => {
      throw cleanup;
    });
    const failure: unknown = await readThroughWorker().catch((caught: unknown) => caught);
    assert(failure instanceof AggregateError);
    expect(failure.errors).toMatchObject([
      { name: error.name, message: error.message },
      { message: cleanup.message },
    ]);
    expect(failure.cause).toBe(failure.errors[1]);
  },
);

it.each([false, true])(
  "retains typed metadata refusal and SQLite cause across worker transfer with cleanup failure=%s",
  async (fails) => {
    const cause = Object.assign(new Error("synthetic SQLite read failure"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 1,
    });
    const primary = new SessionMetadataUnavailableError("table-missing", { cause }, [
      "transcript_events",
    ]);
    const cleanup = new Error("synthetic database close failure");
    observed.read.mockImplementation(() => {
      throw primary;
    });
    if (fails) {
      observed.close.mockImplementation(() => {
        throw cleanup;
      });
    }
    const failure: unknown = await readThroughWorker().catch((error: unknown) => error);
    const unavailable: unknown = failure instanceof AggregateError ? failure.errors[0] : failure;
    expect(unavailable).toBeInstanceOf(SessionMetadataUnavailableError);
    expect(unavailable).toMatchObject({
      reason: "table-missing",
      missingTables: ["transcript_events"],
      cause: { message: cause.message, code: "ERR_SQLITE_ERROR", errcode: 1 },
    });
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors[1]).toMatchObject({ message: cleanup.message });
      expect(failure.cause).toBe(failure.errors[1]);
    }
  },
);

it("retires idle history workers under critical pressure after active scopes release custody", async () => {
  const pressure = channel("openclaw.memory.critical");
  const request = input();
  const retirement = createDeferredCore();
  const unregistered = createDeferredCore();
  observed.run.mockResolvedValue({ ok: true, value: false });
  observed.rotate.mockReturnValue(retirement.promise);
  observed.unregister.mockImplementation(unregistered.resolve);
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    expect(await owner.readEntryPresence(request.scope)).toBe(false);
    pressure.publish(undefined);
    expect(observed.rotate).not.toHaveBeenCalled();
  });

  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  expect(observed.unregister).not.toHaveBeenCalled();
  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  retirement.resolve();
  await unregistered.promise;
  expect(observed.unregister).toHaveBeenCalledTimes(1);
});

it("settles an already-retired read without waiting for a healthy successor rotation", async () => {
  const primary = new WorkerTaskError("retired read cancelled", "unavailable");
  const rotationStarted = createDeferredCore();
  const successorRelease = createDeferredCore();
  observed.run.mockImplementation(async (_request, options) => {
    options.onExecutionSettled?.({ retired: true });
    throw primary;
  });
  observed.rotate.mockImplementation(() => {
    rotationStarted.resolve();
    return successorRelease.promise;
  });
  const request = input();
  const pending = withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  ).catch((error: unknown) => error);
  try {
    expect(
      await Promise.race([
        pending.then(() => "settled"),
        rotationStarted.promise.then(() => "rotating successor"),
      ]),
    ).toBe("settled");
    expect(await pending).toBe(primary);
  } finally {
    successorRelease.resolve();
    await pending;
  }
});

it.each([false, true])(
  "awaits retirement and preserves both failures when retirement fails=%s",
  async (fails) => {
    const primary = new WorkerTaskError("worker response failed", "failed");
    const cleanup = new Error("retirement failed");
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockRejectedValue(primary);
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    const request = input();
    let settled = false;
    const pending = withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    expect(settled).toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    if (fails) {
      retirement.reject(cleanup);
    } else {
      retirement.resolve();
    }
    const failure: unknown = await pending;
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors).toEqual([primary, cleanup]);
      expect(failure.cause).toBe(cleanup);
      expect(failure.message).toContain(primary.message);
      expect(failure.message).toContain(cleanup.message);
      expect(observed.unregister).not.toHaveBeenCalled();
    } else {
      expect(failure).toBe(primary);
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(typedFailures)(
  "preserves typed $reply.kind errors after successful parent retirement",
  async ({ error, reply }) => {
    observed.run.mockResolvedValue({ ok: false, error: reply });
    const request = input();
    const failure: unknown = await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(error.constructor);
    expect(failure).toMatchObject({ message: error.message });
    expect(observed.rotate).toHaveBeenCalledTimes(1);
  },
);

function hydrateThroughWorker() {
  const root = tempDirs.make("openclaw-hydration-quarantine-cleanup-");
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "state", "openclaw-quarantine.sqlite"), "mock quarantine");
  installWorkerTransport();
  return prepareSessionTranscriptHydration({
    agentId: "main",
    sessionId: "quarantine-hydration",
    sessionKey: "agent:main:quarantine-hydration",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    env: { OPENCLAW_STATE_DIR: root },
  }).read();
}

it("hydrates after an ordinary quarantine metadata failure whose native close succeeds", async () => {
  observed.quarantineRead.mockImplementation(() => {
    throw new Error("quarantine metadata unavailable");
  });
  await expect(hydrateThroughWorker()).resolves.toMatchObject({
    kind: "full",
    snapshot: { events: [] },
  });
  expect(observed.quarantineClose).toHaveBeenCalledOnce();
  expect(observed.hydrate).toHaveBeenCalledOnce();
  expect(observed.rotate).not.toHaveBeenCalled();
});

it.each([
  { readFails: false, retirementFails: false },
  { readFails: true, retirementFails: false },
  { readFails: true, retirementFails: true },
])(
  "retains hydration quarantine cleanup custody and graph (read=$readFails, retirement=$retirementFails)",
  async ({ readFails, retirementFails }) => {
    const readFailure = new Error("quarantine metadata read failed");
    const closeFailure = Object.assign(new Error("quarantine native close failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
    const stopFailure = new Error("quarantine worker retirement failed");
    if (readFails) {
      observed.quarantineRead.mockImplementation(() => {
        throw readFailure;
      });
    }
    observed.quarantineClose.mockImplementation(() => {
      throw closeFailure;
    });
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    let settled = false;
    const pending = hydrateThroughWorker()
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      expect(
        await Promise.race([entered.promise.then(() => "retiring"), pending.then(() => "settled")]),
      ).toBe("retiring");
      expect(settled).toBe(false);
      expect(observed.quarantineOpen.mock.results[0]?.value.isOpen).toBe(true);
      expect(observed.hydrate).not.toHaveBeenCalled();
      expect(observed.unregister).not.toHaveBeenCalled();
      if (retirementFails) {
        retirement.reject(stopFailure);
      } else {
        retirement.resolve();
      }
      const result = await pending;
      assert("error" in result);
      const failure = result.error;
      assert(failure instanceof AggregateError);
      const quarantine = retirementFails ? failure.errors[0] : failure;
      assert(quarantine instanceof AggregateError);
      expect(quarantine.name).toBe("OpenClawQuarantineReadCleanupError");
      expect(quarantine.errors).toMatchObject([
        ...(readFails ? [{ message: readFailure.message }] : []),
        { message: closeFailure.message, code: "ERR_SQLITE_ERROR", errcode: 5 },
      ]);
      expect(quarantine.cause).toBe(quarantine.errors[0]);
      expect(observed.rotate).toHaveBeenCalledOnce();
      if (retirementFails) {
        expect(failure.errors[1]).toBe(stopFailure);
        expect(failure.cause).toBe(stopFailure);
        expect(observed.unregister).not.toHaveBeenCalled();
      } else {
        expect(observed.unregister).toHaveBeenCalledOnce();
      }
    } finally {
      retirement.resolve();
      await pending;
    }
  },
);
