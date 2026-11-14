// Register shared worker mocks before modules that consume them.
// oxfmt-ignore
import { input as baseInput, observed } from "./session-transcript-worker-lanes.test-support.js";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { SESSION_TRANSCRIPT_FOREGROUND_WORKERS } from "../../infra/worker-pool-sizing.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import {
  beginGatewayShutdownCleanup,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { createSessionTranscriptHistoryPool } from "./session-transcript-read-pools.js";
import {
  historyLane,
  maintenanceLane,
  projectionLane,
  targetDiscoveryLane,
  transcriptSearchLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import {
  isSessionHistoryWorkerCold,
  prewarmSessionHistoryWorker,
  retainSessionHistoryWorkerDatabase,
  runSessionBranchSummaryWorkerRequest,
  withSessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

function input() {
  const request = baseInput();
  const { database, scope } = request;
  return {
    ...request,
    read: (lane?: Parameters<typeof withSessionHistoryWorkerDatabase>[2]) =>
      withSessionHistoryWorkerDatabase(database, (owner) => owner.readEntryPresence(scope), lane),
    search: (status: Parameters<SessionHistoryWorkerDatabase["searchTranscripts"]>[1]) =>
      withSessionHistoryWorkerDatabase(database, (owner) =>
        owner.searchTranscripts({ agentId: "main", query: "needle" }, status),
      ),
    candidates: [{ path: database.path, physicalPath: database.path }],
    target: {
      kind: "session-store-target" as const,
      logicalAgentId: "main",
      sourcePath: database.path,
      database,
    },
    targetInput: { agentId: "main", storePath: database.path, env: {}, registeredDatabases: [] },
  };
}

const prewarmed = { ok: true as const, value: { kind: "prewarm" as const } };
const absent = { ok: true as const, value: false };

it("retires idle readers during shutdown without interrupting a pending read", async () => {
  const request = input();
  observed.run.mockResolvedValue(absent);
  await request.read(projectionLane);
  const reply = createDeferredCore<unknown>();
  observed.run.mockReturnValueOnce(reply.promise);
  const reading = request.read();
  try {
    expect(historyLane.pending).toBe(1);
    markGatewayRestartDraining();
    beginGatewayShutdownCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.rotate).toHaveBeenCalledTimes(1);
    expect(historyLane.pending).toBe(1);
    reply.resolve(absent);
    await expect(reading).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.rotate).toHaveBeenCalledTimes(2);
    expect([historyLane.native, projectionLane.native]).toEqual([false, false]);
  } finally {
    reply.resolve(absent);
    await reading;
    resetGatewayWorkAdmission();
  }
});

it("keeps native close conservative until an unqualified reader is retired", async () => {
  const pool = createSessionTranscriptHistoryPool();
  const request = { kind: "prewarm" as const, database: input().database, env: {} };
  const read = () => pool.run(() => request, {});
  observed.run.mockResolvedValue(prewarmed);
  try {
    observed.explicitSqliteCloseReleasesNativeResources = false;
    await read();
    observed.rotate.mockRejectedValueOnce(new Error("reader retirement failed"));
    await expect(pool.rotate()).rejects.toThrow("reader retirement failed");
    observed.explicitSqliteCloseReleasesNativeResources = true;
    await read();
    expect(pool.canCloseNativeResources()).toBe(false);
    await pool.rotate();
    await read();
    expect(pool.canCloseNativeResources()).toBe(true);
  } finally {
    observed.rotate.mockResolvedValue(undefined);
    await pool.rotate();
  }
});

it("takes no writer reservations for 150 concurrent cold history reads", async () => {
  observed.preparedDatabase = false;
  const request = input();
  const reservations = channel("openclaw.agent-database.reservation");
  const reserve = vi.fn();
  reservations.subscribe(reserve);
  observed.run.mockResolvedValue({
    ok: true,
    value: { kind: "transcript-watermark", watermark: undefined },
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 150 }, (_, index) =>
        withSessionHistoryWorkerDatabase(request.database, (owner) =>
          owner.readWatermark({ scope: { ...request.scope, sessionId: `cold-${index}` } }),
        ),
      ),
    );
    expect(results).toHaveLength(150);
    expect(observed.run).toHaveBeenCalledTimes(150);
    expect(reserve.mock.calls.length).toBe(0);
  } finally {
    reservations.unsubscribe(reserve);
  }
});

it.each([false, true])(
  "orders cold read admission without holding consumer writes (prepared=%s)",
  async (prepared) => {
    observed.preparedDatabase = prepared;
    const request = input();
    const entered = createDeferredCore();
    const ready = createDeferredCore();
    const writer = runOpenClawAgentWriteAdmission(request.database, async () => {
      entered.resolve();
      await ready.promise;
    });
    await entered.promise;
    observed.run.mockResolvedValue(absent);
    const read = withSessionHistoryWorkerDatabase(request.database, async (owner) => {
      const present = await owner.readEntryPresence(request.scope);
      return runOpenClawAgentWriteAdmission(request.database, () => present);
    });
    try {
      expect(observed.run).toHaveBeenCalledTimes(prepared ? 1 : 0);
    } finally {
      ready.resolve();
      await writer;
      await expect(read).resolves.toBe(false);
    }
  },
);

it.each(["deadline", "revocation"])(
  "cancels cold read admission on %s before the writer settles",
  async (reason) => {
    observed.preparedDatabase = false;
    const request = input();
    const entered = createDeferredCore();
    const ready = createDeferredCore();
    const writer = runOpenClawAgentWriteAdmission(request.database, async () => {
      entered.resolve();
      await ready.promise;
    });
    await entered.promise;
    observed.run.mockResolvedValue(absent);
    const read = request.read();
    let settled = false;
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(read).rejects.toThrow(reason === "deadline" ? "timed out" : "revoked");
    void rejected.catch(() => {});
    try {
      if (reason === "deadline") {
        await vi.advanceTimersByTimeAsync(60_000);
      } else {
        observed.resources.at(-1)!.revoke();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(settled).toBe(true);
      await rejected;
      expect(observed.run).not.toHaveBeenCalled();
    } finally {
      ready.resolve();
      await Promise.allSettled([writer, read, rejected]);
    }
  },
);

it("admits foreground writes while 65 prepared history reads remain queued", async ({ signal }) => {
  observed.serializePools = true;
  const request = input();
  const readersOccupied = createDeferredCore();
  const releaseReaders = createDeferredCore();
  let started = 0;
  let completed = 0;
  observed.run.mockImplementation(async () => {
    if (++started === SESSION_TRANSCRIPT_FOREGROUND_WORKERS) {
      readersOccupied.resolve();
    }
    await releaseReaders.promise;
    completed++;
    return { ok: true, value: { kind: "transcript-watermark", watermark: undefined } };
  });
  const reads = Array.from({ length: 65 }, () =>
    withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readWatermark({ scope: { ...request.scope, sessionId: "history-backlog" } }),
    ),
  );
  let writer: Promise<string> | undefined;
  try {
    await withinTest(readersOccupied.promise, signal);
    expect(started).toBe(SESSION_TRANSCRIPT_FOREGROUND_WORKERS);
    expect(historyLane.pending).toBe(65);
    writer = runOpenClawAgentWriteAdmission(request.database, () => "foreground admitted");
    await expect(withinTest(writer, signal)).resolves.toBe("foreground admitted");
    expect(completed).toBe(0);
    expect(historyLane.pending).toBe(65);
  } finally {
    releaseReaders.resolve();
    await Promise.allSettled([...reads, ...(writer ? [writer] : [])]);
  }
  expect(completed).toBe(65);
});

it("keeps cold reads progressing while history searches await the same writer", async () => {
  observed.serializePools = true;
  const request = input();
  const releaseWriter = createDeferredCore();
  const writerEntered = createDeferredCore();
  const searchesEntered = createDeferredCore();
  const allowStatus = createDeferredCore();
  const releaseOnFailure = createDeferredCore<boolean>();
  const coldQueued = createDeferredCore<boolean>();
  const statuses: Promise<boolean>[] = [];
  let entered = 0;
  observed.run.mockImplementation(async (work, options) => {
    assert(isRecord(work));
    if (work.kind !== "transcript-search") {
      return absent;
    }
    if (++entered === SESSION_TRANSCRIPT_FOREGROUND_WORKERS) {
      searchesEntered.resolve();
    }
    await allowStatus.promise;
    assert(options.onRequest);
    await options.onRequest("transcript-index-status", {
      signal: new AbortController().signal,
      yieldSignal: new AbortController().signal,
    });
    return { ok: true, value: { kind: "transcript-search", result: { hits: [] } } };
  });
  const writer = runOpenClawAgentWriteAdmission(request.database, async () => {
    writerEntered.resolve();
    await releaseWriter.promise;
  });
  await writerEntered.promise;
  const searches = Array.from({ length: SESSION_TRANSCRIPT_FOREGROUND_WORKERS }, () =>
    request.search(() => {
      const status = runOpenClawAgentWriteAdmission(request.database, () => false);
      statuses.push(status);
      return Promise.race([status, releaseOnFailure.promise]);
    }),
  );
  let cold: Promise<boolean> | undefined;
  try {
    await awaitGateBeforeSettlement(
      searchesEntered.promise,
      Promise.all(searches),
      "Searches finished before occupying the history workers",
    );
    observed.preparedDatabase = false;
    observed.queued.mockImplementation((busy) => coldQueued.resolve(busy));
    cold = request.read();
    releaseWriter.resolve();
    await writer;
    // Cold schema admission must not queue behind searches needing the same admission turn.
    expect(await coldQueued.promise).toBe(false);
    allowStatus.resolve();
    expect(await cold).toBe(false);
    expect(await Promise.all(searches)).toEqual(searches.map(() => ({ hits: [] })));
    expect(await Promise.all(statuses)).toEqual(searches.map(() => false));
  } finally {
    releaseWriter.resolve();
    allowStatus.resolve();
    releaseOnFailure.resolve(false);
    await Promise.allSettled([writer, ...searches, ...(cold ? [cold] : [])]);
    await Promise.allSettled(statuses);
  }
});

it("hands admitted read deadlines to the worker pool", async () => {
  observed.preparedDatabase = false;
  const request = input();
  const statusStarted = createDeferredCore();
  const statusReady = createDeferredCore<boolean>();
  let dispatchSignal: AbortSignal | undefined;
  observed.run.mockImplementation(async (_input, options) => {
    dispatchSignal = options.signal;
    assert(dispatchSignal);
    assert(options.onRequest);
    const response = await options.onRequest("transcript-index-status", {
      signal: dispatchSignal,
      yieldSignal: new AbortController().signal,
    });
    expect(response).toMatchObject({ input: false, timeoutMs: 60_000 });
    return { ok: true, value: { kind: "transcript-search", result: { hits: [] } } };
  });
  const searching = request.search(() => {
    statusStarted.resolve();
    return statusReady.promise;
  });
  try {
    await awaitGateBeforeSettlement(
      statusStarted.promise,
      searching,
      "Search finished before requesting its host status",
    );
    await vi.advanceTimersByTimeAsync(60_001);
    expect(dispatchSignal?.aborted).toBe(false);
    statusReady.resolve(false);
    await expect(searching).resolves.toEqual({ hits: [] });
  } finally {
    statusReady.resolve(false);
    await Promise.allSettled([searching]);
  }
});

it("dedupes independent lane prewarms while idle readers retire and regrow", async () => {
  const request = input();
  const warm = [historyLane, transcriptSearchLane];
  const background = [projectionLane, maintenanceLane, targetDiscoveryLane];
  const lanes = [...warm, ...background];
  const prewarm = (lane: (typeof lanes)[number]) =>
    prewarmSessionHistoryWorker(request.database, lane);
  const replies = lanes.map(() => createDeferredCore<unknown>());
  for (const reply of replies) {
    observed.run.mockReturnValueOnce(reply.promise);
  }
  const preparing = lanes.map((lane) => Promise.all([prewarm(lane), prewarm(lane)]));
  try {
    expect(observed.run).toHaveBeenCalledTimes(5);
    expect(observed.run.mock.calls[0]?.[0]).toMatchObject({ kind: "prewarm" });
    expect(lanes.map((lane) => lane.pending)).toEqual([1, 1, 1, 1, 1]);
    replies[0]!.resolve(prewarmed);
    await preparing[0];
    expect(lanes.map((lane) => lane.pending)).toEqual([0, 1, 1, 1, 1]);
    replies.forEach((reply) => reply.resolve(prewarmed));
    await Promise.all(preparing);
    expect(lanes.map((lane) => lane.pending)).toEqual([0, 0, 0, 0, 0]);
    expect(observed.unregister).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(89_999);
    await Promise.all(lanes.map(prewarm));
    expect(observed.run).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(lanes.filter((lane) => !isSessionHistoryWorkerCold(lane))).toEqual(warm);
    expect(observed.rotate).toHaveBeenCalledTimes(3);
    await Promise.all(warm.map(prewarm));
    expect(observed.run).toHaveBeenCalledTimes(5);

    observed.run.mockResolvedValue(absent);
    for (const lane of background) {
      await expect(request.read(lane)).resolves.toBe(false);
      expect(isSessionHistoryWorkerCold(lane)).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(209_999);
    await Promise.all(warm.map(prewarm));
    expect(observed.run).toHaveBeenCalledTimes(8);
    expect(lanes.filter((lane) => !isSessionHistoryWorkerCold(lane))).toEqual(warm);
    await vi.advanceTimersByTimeAsync(1);
    expect(lanes.every((lane) => isSessionHistoryWorkerCold(lane))).toBe(true);
    expect(observed.unregister).toHaveBeenCalledOnce();

    observed.run.mockResolvedValue(prewarmed);
    await Promise.all(lanes.map(prewarm));
    expect(observed.run).toHaveBeenCalledTimes(13);
    expect(lanes.every((lane) => !isSessionHistoryWorkerCold(lane))).toBe(true);
  } finally {
    replies.forEach((reply) => reply.resolve(prewarmed));
    await Promise.all(preparing);
  }
});

it("reuses minute-spaced branch reads and retires after ninety idle seconds", async () => {
  const { database, scope } = input();
  const request = {
    database,
    sessionKey: scope.sessionKey,
  };
  const result = {
    status: "ok" as const,
    branches: [],
    generation: "branch-generation",
    maxSeq: 1,
  };
  const independentRead = vi
    .spyOn(WorkerTaskPool.prototype, "run")
    .mockResolvedValue({ ok: true, value: result });
  observed.run.mockResolvedValue({ ok: true, value: { kind: "branch-summaries", result } });
  const signal = new AbortController().signal;
  try {
    await expect(runSessionBranchSummaryWorkerRequest(request, signal)).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(observed.rotate).not.toHaveBeenCalled();

    await expect(runSessionBranchSummaryWorkerRequest(request, signal)).resolves.toEqual(result);
    expect(independentRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90_000 - 1);
    expect(observed.rotate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(observed.rotate).toHaveBeenCalledOnce();
    expect(isSessionHistoryWorkerCold(maintenanceLane)).toBe(true);
  } finally {
    independentRead.mockRestore();
  }
});

it.each([
  ["history", historyLane, 300_000, transcriptSearchLane],
  ["projection", projectionLane, 90_000, targetDiscoveryLane],
  ["maintenance", maintenanceLane, 90_000, targetDiscoveryLane],
] as const)(
  "keeps %s idle retirement anchored to reads across database cleanup",
  async (_name, lane, idleMs, siblingLane) => {
    observed.run.mockResolvedValue(absent);
    await input().read(lane);
    const resource = observed.resources.at(-1)!;
    await input().read(siblingLane);
    const siblingResource = observed.resources.at(-1)!;

    await vi.advanceTimersByTimeAsync(idleMs * 0.4);
    await siblingResource.close();
    await vi.advanceTimersByTimeAsync(idleMs * 0.4);
    await resource.close();
    await vi.advanceTimersByTimeAsync(idleMs * 0.2 - 1);
    expect(isSessionHistoryWorkerCold(lane)).toBe(false);
    expect(isSessionHistoryWorkerCold(siblingLane)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(isSessionHistoryWorkerCold(lane)).toBe(true);
    expect(isSessionHistoryWorkerCold(siblingLane)).toBe(true);
  },
);

it("rearms idle retirement after expired and explicit native cleanup both fail", async () => {
  observed.explicitSqliteCloseReleasesNativeResources = false;
  observed.run.mockResolvedValue(absent);
  await input().read();
  const resource = observed.resources.at(-1)!;
  const failure = new Error("native retirement failed");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  observed.rotate.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
  try {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(warning).toHaveBeenCalledOnce();
    expect(isSessionHistoryWorkerCold()).toBe(false);
    await expect(resource.close()).rejects.toBe(failure);
    expect(observed.unregister).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(observed.rotate).toHaveBeenCalledTimes(3);
    expect(isSessionHistoryWorkerCold()).toBe(true);
    expect(observed.unregister).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
  }
});

it.each([historyLane, maintenanceLane])(
  "settles failed and revoked $name prewarms without rejecting callers",
  async (lane) => {
    const request = input();
    observed.run.mockRejectedValueOnce(new Error("worker unavailable"));
    await expect(prewarmSessionHistoryWorker(request.database, lane)).resolves.toBeUndefined();
    expect(lane.pending).toBe(0);

    const reply = createDeferredCore<unknown>();
    observed.run.mockReturnValueOnce(reply.promise);
    const pending = prewarmSessionHistoryWorker(request.database, lane);
    const resource = observed.resources.at(-1)!;
    resource.revoke();
    reply.resolve(prewarmed);
    await expect(pending).resolves.toBeUndefined();
    await resource.close();
    expect(lane.pending).toBe(0);
    observed.run.mockResolvedValue(prewarmed);
    await prewarmSessionHistoryWorker(request.database, lane);
    expect(observed.run).toHaveBeenCalledTimes(3);
  },
);

it("maintenance cleanup preserves the independent foreground reader", async () => {
  const request = input();
  const candidates = request.candidates;
  observed.run.mockResolvedValue(absent);
  await request.read();
  await withSessionHistoryWorkerReadCandidates(
    candidates,
    async (scope) => {
      observed.run.mockResolvedValueOnce({
        ok: true,
        value: request.target,
      });
      await scope.readStoreTarget(request.targetInput);
      await request.read(maintenanceLane);
    },
    maintenanceLane,
  );
  expect(observed.unregister).toHaveBeenCalledOnce();
  const retained = observed.resources.find((resource) => resource.agentId === "main");
  assert(retained);
  await retained.close();
  expect(observed.rotate).not.toHaveBeenCalled();
  expect(observed.closeResources).toHaveBeenCalledTimes(3);
  expect(observed.unregister).toHaveBeenCalledTimes(2);
});

it("joins sibling reader cleanup for an eviction reported during discovery cleanup", async () => {
  const request = input();
  const target = request.target;
  const readerReply = createDeferredCore<unknown>();
  const cleanupStarted = createDeferredCore();
  const cleanupFinished = createDeferredCore();
  observed.run
    .mockResolvedValueOnce({ ok: true, value: target })
    .mockReturnValueOnce(readerReply.promise);
  observed.closeResources.mockImplementationOnce(async () => {
    cleanupStarted.resolve();
    await cleanupFinished.promise;
  });
  let missingRead: Promise<boolean> | undefined;
  const discovery = withSessionHistoryWorkerReadCandidates(request.candidates, async (owner) => {
    const selected = await owner.readStoreTarget(request.targetInput);
    missingRead = request.read();
    return selected;
  });
  try {
    await cleanupStarted.promise;
    readerReply.resolve({ ok: true, value: false, closedHistoryDatabase: request.database });
    await expect(missingRead).resolves.toBe(false);
    expect(observed.closeResources).toHaveBeenCalledTimes(2);
    cleanupFinished.resolve();
    await expect(discovery).resolves.toEqual(target);
    expect(observed.rotate).not.toHaveBeenCalled();
  } finally {
    readerReply.resolve({ ok: true, value: false, closedHistoryDatabase: request.database });
    cleanupFinished.resolve();
    await Promise.allSettled([discovery, missingRead]);
  }
});

it("releases missing-store registrations across distinct stores", async () => {
  for (let index = 0; index < 3; index++) {
    const request = input();
    observed.run.mockResolvedValueOnce({
      ok: true,
      value: false,
      closedHistoryDatabase: request.database,
    });
    await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
      await expect(owner.readEntryPresence(request.scope)).resolves.toBe(false);
    });
    expect(observed.unregister).toHaveBeenCalledTimes(index + 1);
  }
  expect(observed.rotate).not.toHaveBeenCalled();
});

it("joins unfinished reads before accepting a sibling eviction", async () => {
  const request = input();
  const preparing = createDeferredCore();
  const read = createDeferredCore<unknown>();
  const rotating = createDeferredCore();
  const retired = createDeferredCore();
  observed.run
    .mockImplementationOnce(() => {
      preparing.resolve();
      return read.promise;
    })
    .mockResolvedValueOnce({ ok: true, value: false, closedHistoryDatabase: request.database });
  observed.rotate.mockImplementationOnce(() => {
    rotating.resolve();
    return retired.promise;
  });
  const sibling = request.read();
  let evicting: Promise<boolean> | undefined;
  try {
    await preparing.promise;
    evicting = request.read();
    await Promise.race([
      rotating.promise,
      evicting.then(() => {
        throw new Error("Eviction released custody while a sibling read was still pending");
      }),
    ]);
    expect(observed.closeResources).not.toHaveBeenCalled();
    expect(observed.unregister).not.toHaveBeenCalled();
    read.resolve(absent);
    await expect(sibling).resolves.toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    retired.resolve();
    await expect(evicting).resolves.toBe(false);
    expect(observed.unregister).toHaveBeenCalledOnce();
  } finally {
    read.resolve(absent);
    retired.resolve();
    await Promise.allSettled([sibling, evicting]);
  }
});

it("joins pending search status before releasing cancelled reader custody", async () => {
  const request = input();
  const statusStarted = createDeferredCore();
  const statusFinished = createDeferredCore<boolean>();
  const cancelled = createDeferredCore();
  const task = new AbortController();
  observed.run.mockImplementation(async (_input, options) => {
    assert(options.onRequest);
    const exchange = options.onRequest("transcript-index-status", {
      signal: task.signal,
      yieldSignal: new AbortController().signal,
    });
    void exchange.catch(() => {});
    await cancelled.promise;
    task.abort();
    throw new Error("reader cancelled");
  });
  const searching = request.search(async () => {
    statusStarted.resolve();
    return statusFinished.promise;
  });
  const settled = vi.fn();
  void searching.then(settled, settled);
  const rejected = expect(searching).rejects.toThrow("reader cancelled");
  await statusStarted.promise;
  const resource = observed.resources.at(-1)!;
  resource.revoke();
  const closing = resource.close();
  const closed = vi.fn();
  void closing.then(closed);
  try {
    cancelled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.rotate).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    statusFinished.resolve(false);
    await Promise.all([rejected, closing]);
    expect(settled).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    cancelled.resolve();
    statusFinished.resolve(false);
    await Promise.allSettled([searching, closing]);
  }
});

it.each([
  { pending: false, capable: false },
  { pending: false, capable: true },
  { pending: true, capable: false },
  { pending: true, capable: true },
])(
  "revokes readers and joins cleanup (pending=$pending, capable=$capable)",
  async ({ pending, capable }) => {
    observed.explicitSqliteCloseReleasesNativeResources = capable;
    const request = input();
    observed.run.mockResolvedValue(absent);
    const owners: SessionHistoryWorkerDatabase[] = [];
    for (const lane of [historyLane, projectionLane, maintenanceLane]) {
      await withSessionHistoryWorkerDatabase(
        request.database,
        async (owner) => {
          await owner.readEntryPresence(request.scope);
          owners.push(owner);
        },
        lane,
      );
    }
    expect(observed.resources).toHaveLength(1);
    const resource = observed.resources[0]!;
    const retained = pending ? retainSessionHistoryWorkerDatabase(request.database) : undefined;
    const foreground = createDeferredCore();
    const projection = createDeferredCore();
    const maintenance = createDeferredCore();
    const cleanup = pending || !capable ? observed.rotate : observed.closeResources;
    cleanup
      .mockReturnValueOnce(foreground.promise)
      .mockReturnValueOnce(projection.promise)
      .mockReturnValueOnce(maintenance.promise);
    resource.revoke();
    retained?.release();
    for (const owner of owners) {
      expect(owner.assertCurrent).toThrow("revoked");
    }
    const closing = resource.close();
    expect(cleanup).toHaveBeenCalledTimes(3);
    foreground.resolve();
    await foreground.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    projection.resolve();
    await projection.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    maintenance.resolve();
    await closing;
    expect(observed.unregister).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])("retains reads dispatched after cleanup (capable=%s)", async (capable) => {
  observed.explicitSqliteCloseReleasesNativeResources = capable;
  const request = input();
  observed.run.mockResolvedValue(absent);
  const read = () => request.read();
  await read();
  const resource = observed.resources.find((entry) => entry.agentId === "main");
  assert(resource);
  const receipt = createDeferredCore();
  const cleanup = capable ? observed.closeResources : observed.rotate;
  cleanup.mockReturnValueOnce(receipt.promise);
  const closing = resource.close();
  const successor = read();
  receipt.resolve();
  await Promise.all([closing, successor]);
  expect(observed.unregister).not.toHaveBeenCalled();
  if (capable) {
    expect(observed.rotate).not.toHaveBeenCalled();
  }
  await resource.close();
  expect(observed.unregister).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it("releases pressure subscriptions after native settlement and rearms reopened lanes", async () => {
  const pressure = channel("openclaw.memory.critical");
  const request = input();
  observed.run.mockResolvedValue(absent);
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    expect(pressure.hasSubscribers).toBe(true);
    expect(await owner.readEntryPresence(request.scope)).toBe(false);
  });
  // A task cannot release reader custody held by another worker in the pool.
  expect(observed.unregister).not.toHaveBeenCalled();
  const retirement = createDeferredCore();
  observed.rotate.mockReturnValueOnce(retirement.promise);
  pressure.publish(undefined);
  const rotation = historyLane.rotation;
  assert(rotation);
  try {
    expect(pressure.hasSubscribers).toBe(true);
  } finally {
    retirement.resolve();
    await rotation;
  }
  expect(observed.unregister).toHaveBeenCalledOnce();
  expect(pressure.hasSubscribers).toBe(false);

  observed.run.mockResolvedValueOnce({
    ok: true,
    value: request.target,
  });
  await withSessionHistoryWorkerReadCandidates(request.candidates, (scope) =>
    scope.readStoreTarget(request.targetInput),
  );
  // Closing discovery readers also leaves their worker available for reuse.
  expect(pressure.hasSubscribers).toBe(true);
  const reopenedRetirement = createDeferredCore();
  observed.rotate.mockReturnValueOnce(reopenedRetirement.promise);
  pressure.publish(undefined);
  const reopenedRotation = historyLane.rotation;
  assert(reopenedRotation);
  const successor = request.read();
  reopenedRetirement.resolve();
  await Promise.all([reopenedRotation, successor]);
  // The queued successor retains its newly opened native reader.
  expect(pressure.hasSubscribers).toBe(true);
  pressure.publish(undefined);
  await historyLane.rotation;
  expect(pressure.hasSubscribers).toBe(false);

  await withSessionHistoryWorkerDatabase(request.database, async () => {
    expect(pressure.hasSubscribers).toBe(true);
  });
  expect(pressure.hasSubscribers).toBe(false);
});
