import "../test-utils/prepare-compiled-subprocesses.js";
import { serialize } from "node:v8";
import { MessagePort } from "node:worker_threads";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteCoordinatorError } from "../infra/sqlite-lifecycle-errors.js";
import {
  failSqliteWorkerSlot,
  receiveSqliteWorkerReply,
  settleSqliteWorkerJob,
} from "../infra/sqlite-worker-broker-reply.js";
import type { Actor, Job } from "../infra/sqlite-worker-broker.types.js";
import {
  isSqliteWorkerError,
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "../infra/sqlite-worker-contract.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { AgentDatabaseDeletionRefusedError } from "./agent-deletion-journal.js";
import type {
  OpenClawAgentDatabaseRegistrationCommit,
  OpenClawAgentDatabaseRegistrationObserver,
} from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseExecutionOpen } from "./openclaw-agent-execution-contract.js";
import { OpenClawQuarantineReadCleanupError } from "./openclaw-quarantine-error.js";
import { hydrateOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

const edge = vi.hoisted(() => {
  const database = {
    agentId: "main",
    path: "/synthetic/agent.sqlite",
    db: { isOpen: true, isTransaction: false },
    walMaintenance: { stop: async () => {} },
  };
  return {
    database,
    on: vi.fn(),
    publishReply: vi.fn(),
    open: vi.fn<
      (
        options: unknown,
        lease: unknown,
        registration?: OpenClawAgentDatabaseRegistrationObserver,
      ) => typeof database
    >(),
    request:
      vi.fn<
        typeof import("../infra/sqlite-worker-operation-admission.js").requestSqliteWorkerOperationAdmission
      >(),
    attachment: vi.fn(() => ({ kind: "agent-execution", startupJournal: false })),
    nativeClose: vi.fn(() => {
      database.db.isOpen = false;
      return true;
    }),
    releaseAgent: vi.fn(),
    releaseShared: vi.fn(),
    forbidden: vi.fn((): never => {
      throw new Error("Registration transport control crossed a native or process boundary");
    }),
  };
});

// The registered worker handler and backend execute; native opening and process custody are synthetic.
vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    parentPort: { on: edge.on, postMessage: edge.publishReply },
    isMainThread: false,
    workerData: null,
    threadId: 1,
    Worker: edge.forbidden,
  };
});
vi.mock("node:child_process", () => ({
  spawn: edge.forbidden,
  spawnSync: edge.forbidden,
  execFile: edge.forbidden,
  execFileSync: edge.forbidden,
  fork: edge.forbidden,
}));
// mock-isolation: Native database opening must remain forbidden in the worker registration fixture.
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: edge.forbidden,
  captureSqliteNativeRuntimeAdmission: () => undefined,
}));
vi.mock("../logging/console.js", () => ({ routeLogsToStderr() {} }));
vi.mock("../process/output-drain.js", () => ({ drainProcessOutput: (done: () => void) => done() }));
vi.mock("../infra/sqlite-worker-identity.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/sqlite-worker-identity.js")>(
    "../infra/sqlite-worker-identity.js",
  )),
  assertExistingDatabaseIdentity() {},
  readDatabasePathIdentitySync: () => ({ key: "file:fixture" }),
}));
vi.mock("../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    requestSqliteWorkerOperationAdmission: (...args: Parameters<typeof edge.request>) => {
      const [request] = args;
      const facts = request.facts;
      if (
        facts &&
        typeof facts === "object" &&
        "validationPort" in facts &&
        facts.validationPort instanceof MessagePort
      ) {
        facts.validationPort.postMessage({ deferUnverifiedIntegrity: false }, []);
      }
      edge.request(...args);
    },
    takeSqliteWorkerOperationAdmissionAttachment: edge.attachment,
  };
});
vi.mock("../infra/sqlite-worker-broker-admission.js", () => ({
  prepareSqliteWorkerActorContext: edge.forbidden,
}));
vi.mock("./openclaw-agent-db.js", () => ({
  openOpenClawAgentDatabase: edge.open,
  getOpenClawAgentDatabaseIfOpen: () => edge.database,
}));
vi.mock("./openclaw-agent-db-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-agent-db-schema.js")>()),
  refreshOpenClawAgentDatabaseSchema: () => undefined,
}));
vi.mock("./openclaw-agent-db-identity.js", () => ({
  readOpenClawAgentDatabaseIdentity: () => ({
    identity: "fixture",
    incarnation: "fixture-incarnation",
    filename: edge.database.path,
  }),
}));
vi.mock("./openclaw-agent-db-lease.js", () => ({
  prepareOpenClawAgentDatabaseWorkerLease: () => ({ receipt: { leaseId: "fixture" } }),
}));
vi.mock("./openclaw-agent-db-lifecycle.js", () => ({
  closeOpenClawAgentDatabaseByPath: edge.nativeClose,
  retainAgentDatabase: () => edge.releaseAgent,
}));
vi.mock("./openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: () => ({ db: { isOpen: true, isTransaction: false } }),
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  requireOpenClawStateDatabaseIdentity: () => ({ key: "file:state" }),
  retainOpenClawStateDatabase: () => ({
    release: edge.releaseShared,
    releaseAsync: edge.releaseShared,
  }),
}));
const input: AgentDatabaseExecutionOpen = {
  leaseId: "fixture",
  agentId: "main",
  databasePath: "/synthetic/agent.sqlite",
  stateDatabasePath: "/synthetic/state.sqlite",
  environment: { OPENCLAW_STATE_DIR: "/synthetic" },
};
const receipt: OpenClawAgentDatabaseRegistrationCommit = {
  agentId: input.agentId,
  agentPath: input.databasePath,
  stateDatabasePath: input.stateDatabasePath,
  stateDatabaseIdentity: "file:state",
};
const replies = new Map<number, Deferred<SqliteWorkerReply>>();
let receive: (request: SqliteWorkerRequest) => void;
let nextId = 0;
let actor = 0;
let nativeOpened = false;
let actorClosed = false;
let actorCloseAttempts = 0;

function send(request: SqliteWorkerRequest): Promise<SqliteWorkerReply> {
  if (request.type === "close" && request.actor === actor) {
    actorCloseAttempts += 1;
  }
  const response = createDeferredCore<SqliteWorkerReply>();
  replies.set(request.id, response);
  receive(request);
  return response.promise;
}

function retireFailedReply(
  reply: Extract<SqliteWorkerReply, { ok: false }>,
  request: SqliteWorkerRequest,
  admissionFailure?: unknown,
) {
  const retired = createDeferredCore();
  const completion = createDeferredCore<unknown>();
  const reject = vi.fn((error: unknown) => completion.resolve(error));
  const settleNative = vi.fn();
  const job: Job = {
    observation: { started() {}, completed() {} },
    request,
    bytes: 0,
    nativeDispatched: true,
    operationAdmission: {
      admission: {
        get port(): MessagePort {
          return edge.forbidden();
        },
        failure: admissionFailure,
        failureSource: admissionFailure === undefined ? undefined : "authority",
        cleanupFailures: [],
        committed: undefined,
        settlement: undefined,
        waitForSettlement: edge.forbidden,
        observeRequests: edge.forbidden,
        service: edge.forbidden,
        bindDatabaseAuthority: edge.forbidden,
        finish() {},
      },
      releaseService() {},
    },
    settleNative,
    resolve: edge.forbidden,
    reject,
    detach() {},
  };
  const slot: Parameters<typeof receiveSqliteWorkerReply>[0] &
    Parameters<typeof failSqliteWorkerSlot>[0] = {
    actors: new Set<Actor>(),
    current: job,
    queue: [],
    worker: { postMessage: edge.forbidden },
  };
  receiveSqliteWorkerReply(slot, reply, {
    fail(error, currentError, openOutcome, completed) {
      failSqliteWorkerSlot(slot, error, {
        currentError,
        openOutcome,
        completed,
        retire: () => retired.promise,
        finish: settleSqliteWorkerJob,
      });
    },
    finish(target, error, _value, settlement) {
      expect(target).toBe(job);
      settleNative(settlement);
      reject(error);
    },
    dispatch() {},
  });
  return { retired, completion, reject, settleNative };
}

beforeAll(async () => {
  await import("../infra/sqlite-store.worker.js");
  const registration = edge.on.mock.calls.find(([event]) => event === "message");
  if (!registration || typeof registration[1] !== "function") {
    throw new Error("SQLite worker did not register its request handler");
  }
  receive = registration[1];
});

beforeEach(async () => {
  vi.clearAllMocks();
  nativeOpened = false;
  actorClosed = false;
  actorCloseAttempts = 0;
  edge.database.db.isOpen = true;
  edge.request.mockImplementation(() => {});
  edge.publishReply.mockImplementation((reply: SqliteWorkerReply) => {
    const pending = replies.get(reply.id);
    if (!pending) {
      throw new Error("SQLite worker replied outside an accepted operation");
    }
    replies.delete(reply.id);
    pending.resolve(reply);
  });
  actor += 1;
  expect(
    await send({
      id: ++nextId,
      actor,
      type: "open",
      moduleUrl: new URL("./openclaw-agent-execution.worker.ts", import.meta.url).href,
      databasePath: input.databasePath,
      existingIdentity: "file:fixture",
      input: serialize(input),
    }),
  ).toMatchObject({ ok: true });
});

afterEach(async () => {
  if (!actorClosed) {
    expect((await send({ id: ++nextId, actor, type: "close" })).ok).toBe(true);
  }
  expect(edge.releaseShared).toHaveBeenCalledTimes(actorCloseAttempts);
  expect(edge.nativeClose).toHaveBeenCalledTimes(nativeOpened ? actorCloseAttempts : 0);
  expect(edge.releaseAgent).toHaveBeenCalledTimes(nativeOpened ? actorCloseAttempts : 0);
  expect(replies.size).toBe(0);
  expect(edge.forbidden).not.toHaveBeenCalled();
});

it("settles eager native factory creation synchronously", async () => {
  const { createSqliteWorkerBackend } = await import("./openclaw-agent-execution.worker.js");
  edge.open.mockImplementation((_options, _lease, registration) => {
    registration?.starting?.();
    registration?.committed?.(receipt);
    nativeOpened = true;
    return edge.database;
  });
  const backend = createSqliteWorkerBackend(input, { databasePath: input.databasePath });
  expect(backend).not.toBeInstanceOf(Promise);
  await backend.close();
  expect(edge.database.db.isOpen).toBe(false);
  expect(edge.releaseAgent).toHaveBeenCalledOnce();
  expect(edge.releaseShared).toHaveBeenCalledOnce();
});

it.each([
  "direct refusal",
  "native and report failure",
  "late deletion refusal",
  "cleanup failure",
  "ordinary closed",
] as const)(
  "preserves creating-open refusal provenance through retirement (%s)",
  async (outcome) => {
    const actual = await vi.importActual<
      typeof import("../infra/sqlite-worker-operation-admission.js")
    >("../infra/sqlite-worker-operation-admission.js");
    const refused = new Error("Original caller retired after registration COMMIT");
    const nativeError =
      outcome === "ordinary closed"
        ? new SqliteWorkerError("Independent native opening failed", "closed")
        : outcome === "late deletion refusal"
          ? new AgentDatabaseDeletionRefusedError("Deletion fence changed after native open")
          : new SqliteCoordinatorError(
              "Independent native opening failed",
              new Error("Native fault"),
            );
    const cleanupError = new SqliteCoordinatorError(
      "Independent native cleanup failed",
      new Error("Cleanup fault"),
    );
    let witnessed = 0;
    const admission = actual.createSqliteWorkerOperationAdmission((request, grant) => {
      if (
        request.stage === "prepare" &&
        request.facts &&
        typeof request.facts === "object" &&
        "kind" in request.facts &&
        request.facts.kind === "agent-registration-committed"
      ) {
        witnessed += 1;
        throw refused;
      }
      grant();
    });
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    edge.request.mockImplementation(actual.requestSqliteWorkerOperationAdmission);
    edge.open.mockImplementation((_options, _lease, registration) => {
      if (outcome === "ordinary closed") {
        throw nativeError;
      }
      registration?.starting?.();
      registration?.committed?.(receipt);
      if (outcome === "native and report failure" || outcome === "late deletion refusal") {
        throw nativeError;
      }
      nativeOpened = true;
      return edge.database;
    });
    if (outcome === "cleanup failure") {
      edge.releaseShared.mockImplementationOnce(() => {
        throw cleanupError;
      });
    }
    const opening: SqliteWorkerRequest = {
      id: ++nextId,
      actor: actor + 1_000_000,
      type: "open",
      moduleUrl: new URL("./openclaw-agent-execution.worker.ts", import.meta.url).href,
      databasePath: input.databasePath,
      input: serialize(input),
      operationAdmission: admission.port,
      stateContext: {
        environment: input.environment,
      },
    };
    try {
      const reply = await send(opening);
      expect(witnessed).toBe(outcome === "ordinary closed" ? 0 : 1);
      if (reply.ok) {
        throw new Error("Failed creating factory unexpectedly succeeded");
      }
      expect(reply.admissionRefused).toBe(outcome === "direct refusal" ? true : undefined);
      expect(reply.openOutcome).toBeUndefined();
      expect(reply.openNotEntered).toBeUndefined();
      // Even an independently retained refusal must not replace an ordinary native error.
      const { retired, completion, reject, settleNative } = retireFailedReply(
        reply,
        opening,
        refused,
      );
      expect(reject).not.toHaveBeenCalled();
      expect(settleNative).not.toHaveBeenCalled();
      retired.resolve();
      const failure = await completion.promise;
      expect(settleNative).toHaveBeenCalledExactlyOnceWith({
        kind: "unknown",
        error: failure,
        nativeStopped: true,
      });
      if (outcome === "direct refusal") {
        expect(failure).toBe(refused);
      } else {
        expect(failure).not.toBe(refused);
        const decoded = hydrateOpenClawStateWorkerError(failure);
        if (outcome === "ordinary closed") {
          expect(decoded).toMatchObject({ message: nativeError.message, code: "closed" });
        } else {
          expect(decoded).toMatchObject({
            errors: expect.arrayContaining([
              expect.objectContaining({
                message: outcome === "cleanup failure" ? cleanupError.message : nativeError.message,
              }),
              expect.objectContaining({
                message: "SQLite transaction admission was refused",
                code: "closed",
              }),
            ]),
          });
        }
      }
    } finally {
      wait.mockRestore();
      admission.finish();
    }
  },
);

describe("committed agent registration across failed native opening", () => {
  it("retains a typed quarantine opening failure after native retirement", async () => {
    const nativeFailure = new Error("synthetic native cleanup failure");
    const cleanup = new OpenClawQuarantineReadCleanupError([nativeFailure], {
      kind: "agent",
      quarantinedAt: 1,
      reason: "synthetic quarantine decision",
    });
    const openingError = Object.assign(
      new Error("synthetic quarantine refusal", { cause: cleanup }),
      {
        name: "SqliteIntegrityError",
      },
    );
    const closeShape = { message: nativeFailure.message };
    const cleanupShape = {
      name: "OpenClawQuarantineReadCleanupError",
      message: cleanup.message,
      cause: closeShape,
      errors: [closeShape],
    };
    edge.open.mockImplementation(() => {
      throw openingError;
    });
    const request: SqliteWorkerRequest = {
      id: ++nextId,
      actor,
      type: "execute",
      stateContext: {
        environment: input.environment,
      },
      input: serialize({ type: "database.prepareWrite", input: undefined }),
    };
    const reply = await send(request);
    expect(reply.ok).toBe(false);
    if (reply.ok) {
      throw new Error("Failed native opening unexpectedly succeeded");
    }
    expect(reply.retire).toBe(true);
    expect(reply.error.sharedState?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: openingError.name, message: openingError.message }),
        expect.objectContaining({ message: nativeFailure.message }),
      ]),
    );
    expect(reply.error.sharedState?.nodes.every((node) => !("quarantine" in node))).toBe(true);

    const { retired, completion, reject, settleNative } = retireFailedReply(reply, request);
    try {
      expect(reject).not.toHaveBeenCalled();
      expect(settleNative).not.toHaveBeenCalled();
      retired.resolve();
      const failure = hydrateOpenClawStateWorkerError(await completion.promise);
      expect(isSqliteWorkerError(failure, "outcome-unknown")).toBe(true);
      expect(settleNative).toHaveBeenCalledExactlyOnceWith({
        kind: "unknown",
        error: expect.objectContaining({ message: openingError.message }),
        nativeStopped: true,
      });
      expect(failure).toMatchObject({
        cause: {
          name: openingError.name,
          message: openingError.message,
          cause: cleanupShape,
        },
      });
    } finally {
      retired.resolve();
      await completion.promise;
    }
  });

  it.each(["native", "shared"] as const)(
    "joins retirement after %s cleanup fails without abandoning other owners",
    async (failureAt) => {
      edge.open.mockImplementation(() => {
        nativeOpened = true;
        return edge.database;
      });
      expect(
        await send({
          id: ++nextId,
          actor,
          type: "execute",
          input: serialize({ type: "database.prepareWrite", input: undefined }),
        }),
      ).toMatchObject({ ok: true });
      const cleanupFailure = new Error(`Synthetic ${failureAt} cleanup failure`);
      const failingCleanup = failureAt === "native" ? edge.nativeClose : edge.releaseShared;
      failingCleanup.mockImplementationOnce(() => {
        throw cleanupFailure;
      });
      const request: SqliteWorkerRequest = {
        id: ++nextId,
        actor,
        type: "close",
        stateDatabasePath: input.stateDatabasePath,
        stateContext: { environment: input.environment },
      };
      const reply = await send(request);
      actorClosed = reply.ok;
      expect(reply).toMatchObject({
        ok: false,
        retire: true,
        error: { message: cleanupFailure.message },
      });
      if (reply.ok) {
        throw new Error("Failed native cleanup unexpectedly succeeded");
      }
      expect(edge.nativeClose).toHaveBeenCalledOnce();
      expect(edge.releaseAgent).toHaveBeenCalledOnce();
      expect(edge.releaseShared).toHaveBeenCalledOnce();
      expect(edge.nativeClose).toHaveBeenCalledBefore(edge.releaseAgent);
      expect(edge.releaseAgent).toHaveBeenCalledBefore(edge.releaseShared);

      const { retired, completion, reject, settleNative } = retireFailedReply(reply, request);
      try {
        expect(reject).not.toHaveBeenCalled();
        expect(settleNative).not.toHaveBeenCalled();
        retired.resolve();
        expect(await completion.promise).toMatchObject({ message: cleanupFailure.message });
        expect(settleNative).toHaveBeenCalledExactlyOnceWith({
          kind: "unknown",
          error: expect.objectContaining({ message: cleanupFailure.message }),
          nativeStopped: true,
        });
      } finally {
        retired.resolve();
        await completion.promise;
      }
    },
  );

  it("reports the COMMIT and joins retirement after a successful open with refused report", async () => {
    const reportingError = new Error("Original caller retired before receipt acknowledgement");
    edge.open.mockImplementation((_options, _lease, registration) => {
      registration?.starting?.();
      registration?.committed?.(receipt);
      nativeOpened = true;
      return edge.database;
    });
    const reported: unknown[] = [];
    edge.request.mockImplementation((request) => {
      if (request.stage === "prepare" && request.facts && typeof request.facts === "object") {
        if ("kind" in request.facts && request.facts.kind === "agent-registration-committed") {
          reported.push(request.facts);
          throw reportingError;
        }
      }
    });
    const reply = await send({
      id: ++nextId,
      actor,
      type: "execute",
      input: serialize({ type: "database.prepareWrite", input: undefined }),
    });
    expect(reported).toEqual([{ kind: "agent-registration-committed", registration: receipt }]);
    expect(reply.ok).toBe(false);
    if (reply.ok) {
      throw new Error("Failed native opening unexpectedly succeeded");
    }
    expect(reply.error.message).toContain(reportingError.message);
    expect(reply.retire).toBe(true);

    const { retired, completion, reject, settleNative } = retireFailedReply(
      reply,
      { type: "execute", id: reply.id, actor, input: new Uint8Array() },
      reportingError,
    );
    expect(reject).not.toHaveBeenCalled();
    expect(settleNative).not.toHaveBeenCalled();
    retired.resolve();
    const failure = await completion.promise;
    expect(failure).toMatchObject({ code: "outcome-unknown" });
    expect(String(failure)).toContain(reportingError.message);
    expect(settleNative).toHaveBeenCalledExactlyOnceWith({
      kind: "unknown",
      error: expect.objectContaining({ message: reply.error.message }),
      nativeStopped: true,
    });
  });

  it("recognizes a separately evaluated backend's inner open refusal before completed settlement", async () => {
    edge.open.mockImplementation(() => {
      nativeOpened = true;
      return edge.database;
    });
    expect(
      await send({
        id: ++nextId,
        actor,
        type: "execute",
        input: serialize({ type: "database.prepareWrite", input: undefined }),
      }),
    ).toMatchObject({ ok: true });
    edge.open.mockClear();
    const initialAdmission = await import("../infra/sqlite-worker-operation-admission.js");
    vi.resetModules();
    const duplicateAdmission = await vi.importActual<
      typeof import("../infra/sqlite-worker-operation-admission.js")
    >("../infra/sqlite-worker-operation-admission.js");
    expect(duplicateAdmission.createSqliteWorkerOperationAdmission).not.toBe(
      initialAdmission.createSqliteWorkerOperationAdmission,
    );
    // Resetting modules alone retains mock factories; install the second actual graph explicitly.
    vi.doMock("../infra/sqlite-worker-operation-admission.js", () => ({
      ...duplicateAdmission,
      requestSqliteWorkerOperationAdmission: edge.request,
      takeSqliteWorkerOperationAdmissionAttachment: edge.attachment,
      withSqliteWorkerOperationAdmission: edge.forbidden,
    }));
    const refused = new Error("Authority revoked after preflight and before native agent open");
    edge.request.mockReset();
    edge.request
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw refused;
      });
    const opening: SqliteWorkerRequest = {
      id: ++nextId,
      actor: actor + 1_000_000,
      type: "open",
      moduleUrl: new URL("./openclaw-agent-execution.worker.ts", import.meta.url).href,
      databasePath: input.databasePath,
      existingIdentity: "file:fixture",
      openAdmission: "input",
      input: serialize(input),
    };
    try {
      const reply = await send(opening);
      expect(reply).toMatchObject({
        ok: false,
        openOutcome: "refused-before-agent-open",
        error: { message: refused.message },
      });
      if (reply.ok) {
        throw new Error("Refused backend unexpectedly opened");
      }
      expect(reply.openNotEntered).toBeUndefined();
      expect(edge.request.mock.calls).toEqual([
        [{ stage: "open", facts: input }],
        [{ stage: "open", facts: input }],
      ]);
      expect(edge.open).not.toHaveBeenCalled();
      const { completion, reject, settleNative } = retireFailedReply(reply, opening, refused);
      expect(reject).toHaveBeenCalledExactlyOnceWith(refused);
      expect(await completion.promise).toBe(refused);
      expect(settleNative).toHaveBeenCalledExactlyOnceWith({ kind: "completed" });
    } finally {
      vi.doMock("../infra/sqlite-worker-operation-admission.js", () => initialAdmission);
      vi.resetModules();
    }
  });
});
