import { afterEach, expect, test, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  isSessionMutationActive,
  runSessionMutation,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import {
  activeRunContext,
  identifiedClient,
  waitForArchivePhase,
  workerPlacement,
  placementReader,
  archiveLifecycleRequestContext,
  archiveTarget,
  expectArchived,
  invokeArchiveHandler,
  invokeVisibilityHandler,
} from "./server.sessions.archive-lifecycle.test-support.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingTargetAsync,
} from "./session-sharing.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { registerWorkerInferenceSessionControl } from "./worker-environments/inference-control-internal.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();

type ArchiveCleanup = {
  signal: AbortSignal;
  track: <T>(promise: Promise<T>) => Promise<T>;
  releaseOnAbort: (release: () => void) => void;
  dispose: (dispose: () => void) => void;
};
const archiveFixture = createFixtureLifetime();
const sharedEntry = {
  createdVia: "operator",
  createdActor: { type: "human", source: "profile", id: "archive-owner" },
  visibility: "shared",
} as const;

async function createArchiveSession(
  name: string,
  entry: Parameters<typeof sessionStoreEntry>[1] = {},
) {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = `agent:main:${name}`;
  const sessionId = `session-${name}`;
  const runId = `run-${name}`;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId, entry) } });
  return {
    storePath,
    sessionKey,
    sessionId,
    runId,
    read: () => loadSessionEntry({ storePath, sessionKey }),
    admit: (signal: AbortSignal, onInterrupt?: () => void) =>
      beginSessionEffect({
        signal,
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
        onInterrupt,
      }),
  };
}

async function activeArchive(
  name: string,
  cleanup: ArchiveCleanup,
  options: Pick<
    Parameters<typeof activeRunContext>[0],
    "ownerConnId" | "terminalPersistenceError"
  > = {},
  entry: Parameters<typeof sessionStoreEntry>[1] = {},
) {
  const session = await createArchiveSession(name, entry);
  const persistence = createDeferredCore();
  const active = await activeRunContext({ ...session, persistence, ...options });
  cleanup.dispose(active.unsubscribe);
  cleanup.releaseOnAbort(() => persistence.resolve());
  return { ...session, persistence, active };
}

function placementFixture(
  session: Pick<WorkerSessionPlacementRecord, "sessionId" | "sessionKey">,
  beforeReclaim?: () => Promise<void>,
) {
  let placement = workerPlacement({ ...session, state: "active" });
  const dispatch = vi.fn();
  const reclaim = vi.fn(async () => {
    if (beforeReclaim) {
      await beforeReclaim();
    }
    placement = workerPlacement({ ...session, state: "reclaimed" });
    return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
  });
  return {
    current: () => placement,
    reclaim,
    dispatch,
    context: {
      workerSessionPlacementService: placementReader(() => placement),
      workerPlacementDispatchService: { dispatch, reclaim },
    },
  };
}

async function captureArchiveAuthority(
  session: Awaited<ReturnType<typeof createArchiveSession>>,
  active: Awaited<ReturnType<typeof activeRunContext>>,
  current: Parameters<typeof placementReader>[0],
  reclaim: WorkerPlacementDispatchService["reclaim"],
) {
  const { sessionKey, sessionId } = session;
  const owner = identifiedClient("archive-owner");
  const archiver = identifiedClient("archive-owner");
  const context = await archiveLifecycleRequestContext(active.context);
  context.workerSessionPlacementService = placementReader(current);
  context.workerPlacementDispatchService = { dispatch: vi.fn(), reclaim };
  await initializeSessionReadContext(context);
  const authorized = resolveSessionMutationAuthorization({
    client: archiver,
    method: "sessions.patch",
    requestParams: { key: sessionKey, archived: true },
    context,
  });
  expect(authorized.error).toBeNull();
  const authorization = authorized.authorization;
  if (!authorization) {
    throw new Error("expected captured archive authorization");
  }
  return {
    context,
    archiver,
    share: () =>
      invokeVisibilityHandler({ client: owner, context, sessionKey, visibility: "draft" }),
    archive: () =>
      invokeArchiveHandler({
        authorization,
        client: archiver,
        context,
        sessionKey,
        expectedSessionId: sessionId,
      }),
  };
}

async function createArchiveBatch() {
  const { storePath } = await createSessionStoreDir();
  const keys = ["agent:main:archive-first", "agent:main:archive-second"] as const;
  const ids = ["session-first", "session-second"] as const;
  await writeSessionStore({
    entries: Object.fromEntries(keys.map((key, i) => [key, sessionStoreEntry(ids[i]!)])),
  });
  return {
    storePath,
    keys,
    ids,
    archive: (context?: Record<string, unknown>) =>
      directSessionReq<{
        outcomes: Array<{
          key: string;
          ok: boolean;
          error?: { code: string; retryable?: boolean };
        }>;
      }>(
        "sessions.patchMany",
        { targets: keys.map((key, i) => archiveTarget(key, ids[i]!)), patch: { archived: true } },
        { context },
      ),
    expectArchived: () => keys.forEach((key) => expectArchived(storePath, key)),
    success: keys.map((key) => ({ key, ok: true })),
  };
}

function archiveSession(
  sessionKey: string,
  sessionId: string,
  options: Parameters<typeof directSessionReq>[2] = {},
) {
  return directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    options,
  );
}

function expectArchiveUnavailable(
  result: Awaited<ReturnType<typeof archiveSession>>,
  storePath: string,
  sessionKey: string,
) {
  expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
}

function withArchiveCleanup(signal: AbortSignal, run: (fixture: ArchiveCleanup) => Promise<void>) {
  return archiveFixture.run(async () => {
    signal.throwIfAborted();
    const releases: Array<() => void> = [];
    const disposals: Array<() => void> = [];
    const pending: Promise<unknown>[] = [];
    const release = () => releases.forEach((cleanup) => cleanup());
    signal.addEventListener("abort", release, { once: true });
    try {
      await run({
        signal,
        track: (promise) => {
          pending.push(promise);
          return promise;
        },
        releaseOnAbort: (cleanup) => {
          releases.push(cleanup);
          if (signal.aborted) {
            cleanup();
          }
        },
        dispose: (cleanup) => disposals.push(cleanup),
      });
    } finally {
      release();
      await Promise.allSettled(pending);
      disposals.forEach((cleanup) => cleanup());
      signal.removeEventListener("abort", release);
    }
  });
}

function archiveTest(name: string, run: (fixture: ArchiveCleanup) => Promise<void>) {
  test(name, ({ signal }) => withArchiveCleanup(signal, run));
}

afterEach(async () => {
  // Vitest cancellation rejects its wrapper before the retained handler body finishes.
  await archiveFixture.cleanup();
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

archiveTest(
  "sessions.patch cancels active work and commits only after admission and terminal persistence drain",
  async (cleanup) => {
    const { signal, track } = cleanup;
    const { storePath, sessionKey, sessionId, active, persistence } = await activeArchive(
      "archive-active",
      cleanup,
      { ownerConnId: "different-connection" },
    );
    const archive = track(
      archiveSession(sessionKey, sessionId, {
        context: active.context,
        client: { connId: "archive-writer", connect: { scopes: ["operator.write"] } } as never,
      }),
    );
    await waitForArchivePhase(active.aborted, archive, signal);
    expect(active.controller.signal.aborted).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();

    let replacementAdmitted = false;
    const replacement = track(
      beginSessionEffect({
        signal,
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {
          replacementAdmitted = true;
          if (loadSessionEntry({ storePath, sessionKey })?.archivedAt !== undefined) {
            throw new Error("archived");
          }
        },
      }).then(
        (lease) => {
          // Unexpected admission still owns a lease; the assertion below rejects the result.
          lease.release();
          return lease;
        },
        (error: unknown) => error,
      ),
    );
    await Promise.resolve();
    expect(replacementAdmitted).toBe(false);

    await Promise.resolve();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    persistence.resolve();

    const archived = await archive;
    expect(archived.ok).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
    expect(await replacement).toBeInstanceOf(Error);
  },
);

archiveTest(
  "identity changes fence archive before cancellation and force fresh authorization",
  async (cleanup) => {
    const { signal, track, releaseOnAbort } = cleanup;
    const session = await activeArchive("archive-sharing-revocation", cleanup, {}, sharedEntry);
    const { storePath, sessionKey, sessionId, active } = session;
    let interrupted = false;
    const admission = await session.admit(signal, () => {
      interrupted = true;
    });
    const sharingCommitted = createDeferredCore();
    const releaseSharingMutation = createDeferredCore();
    releaseOnAbort(() => {
      releaseSharingMutation.resolve();
      admission.release();
    });
    const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
    const reclaim = vi.fn();
    const authority = await captureArchiveAuthority(session, active, () => placement, reclaim);
    const { context: requestContext, archiver } = authority;
    const sharingTarget = await resolveSessionSharingTargetAsync({
      cfg: requestContext.getRuntimeConfig(),
      sessionKey,
    });
    if (!sharingTarget) {
      throw new Error("expected resolved sharing target");
    }

    let sharingSettled = false;
    const sharing = track(
      runSessionMutation({
        scope: sharingTarget.storePath,
        identities: [
          sharingTarget.canonicalKey,
          sharingTarget.storeKey,
          ...sharingTarget.storeKeys,
          sharingTarget.entry.sessionId,
        ],
        run: async () => {
          const response = await authority.share();
          sharingCommitted.resolve();
          await releaseSharingMutation.promise;
          return response;
        },
      }).finally(() => {
        sharingSettled = true;
      }),
    );
    await waitForArchivePhase(sharingCommitted.promise, sharing, signal);
    expect(isSessionMutationActive(sharingTarget.storePath, [sessionKey, sessionId])).toBe(true);
    expect(sharingSettled).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("draft");
    archiver.authenticatedUserProfile!.profileId = "archive-viewer";

    let archiveSettled = false;
    const archive = track(
      authority.archive().finally(() => {
        archiveSettled = true;
      }),
    );
    await Promise.resolve();
    expect(archiveSettled).toBe(false);
    expect(interrupted).toBe(false);
    expect(active.controller.signal.aborted).toBe(false);
    expectNoSessionQueueCleanup();
    expect(reclaim).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();

    releaseSharingMutation.resolve();
    expect(await sharing).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("draft");

    expect(await archive).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(interrupted).toBe(false);
    expect(active.controller.signal.aborted).toBe(false);
    expectNoSessionQueueCleanup();
    expect(reclaim).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  },
);

test.for(["creator", "changed identity"] as const)(
  "archive permits sharing during drain and revalidates the %s before commit",
  (archiveRole, { signal }) =>
    withArchiveCleanup(signal, async (cleanup) => {
      const { track, releaseOnAbort } = cleanup;
      const session = await activeArchive("archive-before-sharing", cleanup, {}, sharedEntry);
      const { storePath, sessionKey, active, persistence } = session;
      const reclaimGate = createDeferredCore();
      const reclaimEntered = createDeferredCore();
      releaseOnAbort(() => {
        reclaimGate.resolve();
      });
      const { current, reclaim } = placementFixture(session, async () => {
        reclaimEntered.resolve();
        await reclaimGate.promise;
      });
      const authority = await captureArchiveAuthority(session, active, current, reclaim);
      const { archiver } = authority;

      const archive = track(authority.archive());
      await waitForArchivePhase(active.aborted, archive, signal);
      expect(active.controller.signal.aborted).toBe(true);

      const sharing = track(authority.share());
      expect(await sharing).toMatchObject({ ok: true });
      expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("draft");
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
      if (archiveRole === "changed identity") {
        archiver.authenticatedUserProfile!.profileId = "archive-viewer";
      }

      persistence.resolve();
      if (archiveRole === "changed identity") {
        expect(await archive).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(reclaim).not.toHaveBeenCalled();
        expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
        return;
      }
      await waitForArchivePhase(reclaimEntered.promise, archive, signal);
      expect(reclaim).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
      reclaimGate.resolve();
      expect(await archive).toMatchObject({ ok: true });
      expect(session.read()).toMatchObject({ archivedAt: expect.any(Number), visibility: "draft" });
    }),
);

archiveTest(
  "alias archive lets an earlier alias mutation finish before canonical reclaim",
  async ({ signal, track, releaseOnAbort }) => {
    const aliasKey = "aaa-archive-cloud-alias";
    const session = await createArchiveSession(aliasKey);
    const { storePath, sessionKey, sessionId } = session;
    const reclaimEntered = createDeferredCore();
    const allowNestedReclaim = createDeferredCore();
    const contenderRelease = createDeferredCore();
    const contenderStarted = createDeferredCore();
    const { current, reclaim, context } = placementFixture(session, async () => {
      reclaimEntered.resolve();
      await allowNestedReclaim.promise;
      await runSessionMutation({
        scope: storePath,
        identities: [aliasKey, sessionKey, sessionId],
        run: async () => {},
      });
    });
    releaseOnAbort(() => {
      contenderRelease.resolve();
      allowNestedReclaim.resolve();
    });
    const archive = track(archiveSession(aliasKey, sessionId, { context }));
    await racePromiseWithAbortSignal(reclaimEntered.promise, signal);
    const contender = track(
      runSessionMutation({
        scope: storePath,
        identities: [aliasKey],
        run: async () => {
          contenderStarted.resolve();
          await contenderRelease.promise;
        },
      }),
    );
    await racePromiseWithAbortSignal(contenderStarted.promise, signal);
    allowNestedReclaim.resolve();

    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    contenderRelease.resolve();
    const [result] = await Promise.all([archive, contender]);
    expect(result.ok).toBe(true);
    expect(reclaim).toHaveBeenCalledOnce();
    expect(current().state).toBe("reclaimed");
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  },
);

test("sessions.patch returns its drain timeout while cleanup still fences admission", async () => {
  const { storePath, sessionKey, sessionId, runId } =
    await createArchiveSession("archive-owned-timeout");
  const persistence = createDeferredCore();
  const active = await activeRunContext({ runId, sessionId, sessionKey, persistence });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let responded = false;
  let successorEntered = false;
  let successor: Promise<void> | undefined;
  const cleanup = new AsyncWorkScope();
  const archive = archiveSession(sessionKey, sessionId, {
    context: {
      ...active.context,
      trackExecution: <T>(run: () => T | Promise<T>) => cleanup.track(run),
    },
  }).then((result) => {
    responded = true;
    return result;
  });
  try {
    await active.aborted;
    await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS + 1);
    expect(responded).toBe(true);
    const result = await archive;
    expectArchiveUnavailable(result, storePath, sessionKey);
    successor = withSessionTurn({ storePath, sessionKey, sessionId }, async () => {
      successorEntered = true;
    });
    await Promise.resolve();
    expect(successorEntered).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    persistence.resolve();
    await archive;
    await cleanup.drain();
    await successor;
    successor = undefined;
    expect(successorEntered).toBe(true);
  } finally {
    persistence.resolve();
    await archive;
    await cleanup.drain();
    if (successor) {
      await successor.catch(() => undefined);
    }
    active.unsubscribe();
    vi.useRealTimers();
  }
});

test.each(["active work", "unavailable drain", "runtime drain rejection"] as const)(
  "sessions.patch fails closed on %s",
  async (failure) => {
    const retained = { abortedLastRun: true, lifecycleRunId: "retained-worker-run" };
    const { storePath, sessionKey, sessionId } = await createArchiveSession(
      "archive-worker-drain",
      failure === "active work" ? retained : {},
    );
    const release = vi.fn();
    const workerEnvironmentService =
      failure === "active work"
        ? createWorkerInferenceDrainService(() => ({
            drained: Promise.resolve(),
            hasWork: () => true,
            release,
          }))
        : failure === "runtime drain rejection"
          ? createWorkerInferenceDrainService(() => {
              throw new Error("runtime drain refused");
            })
          : {};
    if (failure === "unavailable drain") {
      registerWorkerInferenceSessionControl(workerEnvironmentService, {
        hasSession: () => true,
        reserveSessionDrain: () => {
          throw new Error("Worker inference drain is unavailable");
        },
        captureSessionCancellation: () => ({ runIds: [], cancel: async () => [] }),
        resolveSessionTargetForRunId: () => undefined,
      });
    }
    const archived = await archiveSession(sessionKey, sessionId, {
      context: { workerEnvironmentService },
    });
    expectArchiveUnavailable(archived, storePath, sessionKey);
    if (failure === "active work") {
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(retained);
      expect(release).toHaveBeenCalledOnce();
    }
  },
);

archiveTest(
  "sessions.patch returns UNAVAILABLE when terminal persistence fails",
  async (cleanup) => {
    const { signal, track } = cleanup;
    const { storePath, sessionKey, sessionId, active } = await activeArchive(
      "archive-persistence-failure",
      cleanup,
      { terminalPersistenceError: new Error("disk full") },
    );

    const archive = track(archiveSession(sessionKey, sessionId, { context: active.context }));
    const archived = await racePromiseWithAbortSignal(archive, signal);
    expect(active.controller.signal.aborted).toBe(true);
    expectArchiveUnavailable(archived, storePath, sessionKey);
  },
);

test.each(["main", "global", "unknown"] as const)(
  "sessions.patch rejects %s before cancellation or entry creation",
  async (key) => {
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({
      entries: key === "main" ? { main: sessionStoreEntry("session-main") } : {},
    });
    const globalFixture =
      key === "global" ? await createConfiguredGlobalAgentSessionStore() : undefined;
    if (key !== "unknown") {
      embeddedRunMock.activeIds.add(key === "main" ? "session-main" : "sess-main-global");
    }
    try {
      const result = await directSessionReq("sessions.patch", {
        key,
        archived: true,
        ...(key === "global" ? { agentId: "main" } : {}),
      });
      const message = key === "unknown" ? "unknown session sentinel" : "main session";
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(message) },
      });
      expect(embeddedRunMock.abortCalls).toEqual([]);
      expectNoSessionQueueCleanup();
      if (key === "unknown") {
        expect(loadSessionEntry({ storePath, sessionKey: key })).toBeUndefined();
      } else if (key === "main") {
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
      }
    } finally {
      if (globalFixture) {
        await resetConfiguredGlobalAgentSessionStore(globalFixture);
      }
    }
  },
);

test.for([
  ["prepares independent archive drains concurrently and releases in target order", false],
  ["attempts every archive drain release without masking success", true],
] as const)("sessions.patchMany %s", ([, releaseFails], { signal }) =>
  withArchiveCleanup(signal, async ({ track, releaseOnAbort }) => {
    const batch = await createArchiveBatch();
    const {
      ids: [firstSessionId, secondSessionId],
    } = batch;
    const firstDrained = createDeferredCore();
    const firstStarted = createDeferredCore();
    const secondStarted = createDeferredCore();
    const firstRelease = vi.fn(() => {
      if (releaseFails) {
        throw new Error("release failed");
      }
    });
    const secondRelease = vi.fn();
    const beginInferenceSessionDrain = vi.fn((sessionId: string) => {
      (sessionId === firstSessionId ? firstStarted : secondStarted).resolve();
      return {
        drained: sessionId === firstSessionId ? firstDrained.promise : Promise.resolve(),
        hasWork: () => false,
        release: sessionId === firstSessionId ? firstRelease : secondRelease,
      };
    });

    releaseOnAbort(() => firstDrained.resolve());
    const archive = track(
      batch.archive({
        workerEnvironmentService: createWorkerInferenceDrainService(beginInferenceSessionDrain),
      }),
    );
    await waitForArchivePhase(
      Promise.all([firstStarted.promise, secondStarted.promise]),
      archive,
      signal,
    );
    expect(beginInferenceSessionDrain).toHaveBeenCalledTimes(2);
    expect(beginInferenceSessionDrain.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      firstSessionId,
      secondSessionId,
    ]);
    expect(firstRelease).not.toHaveBeenCalled();
    expect(secondRelease).not.toHaveBeenCalled();
    firstDrained.resolve();

    const result = await archive;
    expect(result.ok).toBe(true);
    expect(result.payload?.outcomes).toEqual(batch.success);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(firstRelease.mock.invocationCallOrder[0]).toBeLessThan(
      secondRelease.mock.invocationCallOrder[0]!,
    );
    batch.expectArchived();
  }),
);

test("sessions.patchMany isolates a failed archive drain and continues later targets", async () => {
  const batch = await createArchiveBatch();
  const {
    storePath,
    keys: [stuckKey, idleKey],
    ids: [stuckSessionId],
  } = batch;
  const workerEnvironmentService = createWorkerInferenceDrainService((sessionId) => {
    if (sessionId === stuckSessionId) {
      throw new Error("runtime drain refused");
    }
    return { drained: Promise.resolve(), hasWork: () => false, release: () => {} };
  });

  const result = await batch.archive({ workerEnvironmentService });

  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    {
      key: stuckKey,
      ok: false,
      error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    },
    { key: idleKey, ok: true },
  ]);
  expect(loadSessionEntry({ storePath, sessionKey: stuckKey })?.archivedAt).toBeUndefined();
  expectArchived(storePath, idleKey);
});

archiveTest(
  "sessions.patch rejects a generation replaced after the exact preparation read",
  async (cleanup) => {
    const { signal, track } = cleanup;
    const session = await activeArchive("archive-generation-race", cleanup);
    const { storePath, sessionKey, sessionId, active, persistence } = session;
    const { current, dispatch, reclaim, context } = placementFixture(session);
    const archive = track(
      archiveSession(sessionKey, sessionId, { context: { ...active.context, ...context } }),
    );
    await waitForArchivePhase(active.terminalStarted, archive, signal);
    expect(active.controller.signal.aborted).toBe(true);
    await upsertSessionEntryCore(
      { storePath, sessionKey },
      { sessionId: "session-archive-generation-replacement", updatedAt: 2 },
    );
    persistence.resolve();

    const archived = await archive;
    expect(archived.ok).toBe(false);
    expect(archived.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "session-changed" },
    });
    expect(session.read()).toMatchObject({ sessionId: "session-archive-generation-replacement" });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(reclaim).not.toHaveBeenCalled();
    expect(current().state).toBe("active");
    expect(dispatch).not.toHaveBeenCalled();
  },
);
