// Archive lifecycle tests protect fence-before-cancel, terminal drains, and sentinels.
import { afterEach, expect, test, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
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
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();

const archiveFixture = createFixtureLifetime();

function withArchiveCleanup(
  signal: AbortSignal,
  run: (fixture: {
    track: <T>(promise: Promise<T>) => Promise<T>;
    releaseOnAbort: (release: () => void) => void;
    dispose: (dispose: () => void) => void;
  }) => Promise<void>,
) {
  return archiveFixture.run(async () => {
    signal.throwIfAborted();
    const releases: Array<() => void> = [];
    const disposals: Array<() => void> = [];
    const pending: Promise<unknown>[] = [];
    const release = () => releases.forEach((cleanup) => cleanup());
    signal.addEventListener("abort", release, { once: true });
    try {
      await run({
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

afterEach(async () => {
  // Vitest cancellation rejects its wrapper before the retained handler body finishes.
  await archiveFixture.cleanup();
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test("sessions.patch cancels active work and commits only after admission and terminal persistence drain", ({
  signal,
}) =>
  withArchiveCleanup(signal, async ({ track, releaseOnAbort, dispose }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:archive-active";
    const sessionId = "session-archive-active";
    const runId = "run-archive-active";
    await writeSessionStore({
      entries: { [sessionKey]: sessionStoreEntry(sessionId) },
    });
    const interrupted = createDeferredCore();
    const admission = await beginSessionWorkAdmission({
      signal,
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: () => interrupted.resolve(),
    });
    const persistence = createDeferredCore();
    releaseOnAbort(() => {
      admission.release();
      persistence.resolve();
    });
    const active = activeRunContext({
      runId,
      sessionId,
      sessionKey,
      persistence,
      ownerConnId: "different-connection",
    });
    dispose(active.unsubscribe);
    const archive = track(
      directSessionReq(
        "sessions.patch",
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        {
          context: active.context,
          client: { connId: "archive-writer", connect: { scopes: ["operator.write"] } } as never,
        },
      ),
    );
    await racePromiseWithAbortSignal(interrupted.promise, signal);
    expect(active.controller.signal.aborted).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();

    let replacementAdmitted = false;
    const replacement = track(
      beginSessionWorkAdmission({
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

    admission.release();
    await Promise.resolve();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    persistence.resolve();

    const archived = await archive;
    expect(archived.ok).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
    expect(await replacement).toBeInstanceOf(Error);
  }));

test("identity changes fence archive before cancellation and force fresh authorization", ({
  signal,
}) =>
  withArchiveCleanup(signal, async ({ track, releaseOnAbort, dispose }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:archive-sharing-revocation";
    const sessionId = "session-archive-sharing-revocation";
    const runId = "run-archive-sharing-revocation";
    const owner = identifiedClient("archive-owner");
    const archiver = identifiedClient("archive-owner");
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "archive-owner" },
          visibility: "shared",
        }),
      },
    });
    let interrupted = false;
    const admission = await beginSessionWorkAdmission({
      signal,
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        interrupted = true;
      },
    });
    const persistence = createDeferredCore();
    const sharingCommitted = createDeferredCore();
    const releaseSharingMutation = createDeferredCore();
    releaseOnAbort(() => {
      releaseSharingMutation.resolve();
      admission.release();
      persistence.resolve();
    });
    const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
    dispose(active.unsubscribe);
    const requestContext = await archiveLifecycleRequestContext(active.context);
    const placement = workerPlacement({ sessionId, sessionKey, state: "active" });
    const reclaim = vi.fn();
    requestContext.workerSessionPlacementService = placementReader(() => placement);
    requestContext.workerPlacementDispatchService = { dispatch: vi.fn(), reclaim };
    await initializeSessionReadContext(requestContext);
    const authorized = resolveSessionMutationAuthorization({
      client: archiver,
      method: "sessions.patch",
      requestParams: { key: sessionKey, archived: true },
      context: requestContext,
    });
    expect(authorized.error).toBeNull();
    if (!authorized.authorization) {
      throw new Error("expected captured archive authorization");
    }
    const sharingTarget = resolveSessionSharingTarget({
      cfg: requestContext.getRuntimeConfig(),
      sessionKey,
    });
    if (!sharingTarget) {
      throw new Error("expected resolved sharing target");
    }

    let sharingSettled = false;
    const sharing = track(
      runExclusiveSessionLifecycleMutation({
        scope: sharingTarget.storePath,
        identities: [
          sharingTarget.canonicalKey,
          sharingTarget.storeKey,
          ...sharingTarget.storeKeys,
          sharingTarget.entry.sessionId,
        ],
        run: async () => {
          const response = await invokeVisibilityHandler({
            client: owner,
            context: requestContext,
            sessionKey,
            visibility: "draft",
          });
          sharingCommitted.resolve();
          await releaseSharingMutation.promise;
          return response;
        },
      }).finally(() => {
        sharingSettled = true;
      }),
    );
    await waitForArchivePhase(sharingCommitted.promise, sharing, signal);
    expect(isSessionLifecycleMutationActive(sharingTarget.storePath, [sessionKey, sessionId])).toBe(
      true,
    );
    expect(sharingSettled).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("draft");
    archiver.authenticatedUserProfile!.profileId = "archive-viewer";

    let archiveSettled = false;
    const archive = track(
      invokeArchiveHandler({
        authorization: authorized.authorization,
        client: archiver,
        context: requestContext,
        sessionKey,
        expectedSessionId: sessionId,
      }).finally(() => {
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

    expect(await archive).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(interrupted).toBe(false);
    expect(active.controller.signal.aborted).toBe(false);
    expectNoSessionQueueCleanup();
    expect(reclaim).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  }));

test.for(["creator", "changed identity"] as const)(
  "archive permits sharing during drain and revalidates the %s before commit",
  (archiveRole, { signal }) =>
    withArchiveCleanup(signal, async ({ track, releaseOnAbort, dispose }) => {
      const { storePath } = await createSessionStoreDir();
      const sessionKey = "agent:main:archive-before-sharing";
      const sessionId = "session-archive-before-sharing";
      const runId = "run-archive-before-sharing";
      const owner = identifiedClient("archive-owner");
      const archiver = identifiedClient("archive-owner");
      await writeSessionStore({
        entries: {
          [sessionKey]: sessionStoreEntry(sessionId, {
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: "archive-owner" },
            visibility: "shared",
          }),
        },
      });
      const admission = await beginSessionWorkAdmission({
        signal,
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      const persistence = createDeferredCore();
      const reclaimGate = createDeferredCore();
      const reclaimEntered = createDeferredCore();
      releaseOnAbort(() => {
        admission.release();
        persistence.resolve();
        reclaimGate.resolve();
      });
      const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
      dispose(active.unsubscribe);
      const requestContext = await archiveLifecycleRequestContext(active.context);
      let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
      const reclaim = vi.fn(async () => {
        reclaimEntered.resolve();
        await reclaimGate.promise;
        placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
        return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
      });
      requestContext.workerSessionPlacementService = placementReader(() => placement);
      requestContext.workerPlacementDispatchService = { dispatch: vi.fn(), reclaim };
      await initializeSessionReadContext(requestContext);
      const authorized = resolveSessionMutationAuthorization({
        client: archiver,
        method: "sessions.patch",
        requestParams: { key: sessionKey, archived: true },
        context: requestContext,
      });
      expect(authorized.error).toBeNull();
      if (!authorized.authorization) {
        throw new Error("expected captured archive authorization");
      }

      const archive = track(
        invokeArchiveHandler({
          authorization: authorized.authorization,
          client: archiver,
          context: requestContext,
          sessionKey,
          expectedSessionId: sessionId,
        }),
      );
      await waitForArchivePhase(active.aborted, archive, signal);
      expect(active.controller.signal.aborted).toBe(true);

      const sharing = track(
        invokeVisibilityHandler({
          client: owner,
          context: requestContext,
          sessionKey,
          visibility: "draft",
        }),
      );
      expect(await sharing).toMatchObject({ ok: true });
      expect(loadSessionEntry({ storePath, sessionKey })?.visibility).toBe("draft");
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
      if (archiveRole === "changed identity") {
        archiver.authenticatedUserProfile!.profileId = "archive-viewer";
      }

      admission.release();
      persistence.resolve();
      if (archiveRole === "changed identity") {
        expect(await archive).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN" },
        });
        expect(reclaim).not.toHaveBeenCalled();
        expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
        return;
      }
      await waitForArchivePhase(reclaimEntered.promise, archive, signal);
      expect(reclaim).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
      reclaimGate.resolve();
      expect(await archive).toMatchObject({ ok: true });
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
      expect(await sharing).toMatchObject({ ok: true });
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        archivedAt: expect.any(Number),
        visibility: "draft",
      });
    }),
);

test("alias archive lets an earlier alias mutation finish before canonical reclaim", ({ signal }) =>
  withArchiveCleanup(signal, async ({ track, releaseOnAbort }) => {
    const { storePath } = await createSessionStoreDir();
    const aliasKey = "aaa-archive-cloud-alias";
    const sessionKey = `agent:main:${aliasKey}`;
    const sessionId = "session-archive-cloud-alias";
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
    const reclaimEntered = createDeferredCore();
    const allowNestedReclaim = createDeferredCore();
    const contenderRelease = createDeferredCore();
    const contenderStarted = createDeferredCore();
    const reclaim = vi.fn(async () => {
      reclaimEntered.resolve();
      await allowNestedReclaim.promise;
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [aliasKey, sessionKey, sessionId],
        run: async () => {},
      });
      placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
      return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
    });
    releaseOnAbort(() => {
      contenderRelease.resolve();
      allowNestedReclaim.resolve();
    });
    const archive = track(
      directSessionReq(
        "sessions.patch",
        { key: aliasKey, archived: true, expectedSessionId: sessionId },
        {
          context: {
            workerSessionPlacementService: placementReader(() => placement),
            workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
          },
        },
      ),
    );
    await racePromiseWithAbortSignal(reclaimEntered.promise, signal);
    const contender = track(
      runExclusiveSessionLifecycleMutation({
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
    expect(placement.state).toBe("reclaimed");
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  }));

test("sessions.patch rechecks authoritative worker work before projection and releases the drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-worker-recheck";
  const sessionId = "session-archive-worker-recheck";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const release = vi.fn();
  const workerEnvironmentService = createWorkerInferenceDrainService(() => ({
    drained: Promise.resolve(),
    hasWork: () => true,
    release,
  }));

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerEnvironmentService,
      },
    },
  );

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
});

test("sessions.patch fails closed when active worker inference has no archive drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-worker-drain-unavailable";
  const sessionId = "session-archive-worker-drain-unavailable";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        workerEnvironmentService: {
          cancelInferenceForSession: vi.fn(() => []),
          hasInferenceForSession: vi.fn(() => true),
        },
      },
    },
  );

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch returns UNAVAILABLE when terminal persistence fails", ({ signal }) =>
  withArchiveCleanup(signal, async ({ track, releaseOnAbort, dispose }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:archive-persistence-failure";
    const sessionId = "session-archive-persistence-failure";
    const runId = "run-archive-persistence-failure";
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    const persistence = createDeferredCore();
    releaseOnAbort(() => persistence.resolve());
    const active = activeRunContext({
      runId,
      sessionId,
      sessionKey,
      persistence,
      terminalPersistenceError: new Error("disk full"),
    });
    dispose(active.unsubscribe);
    const archive = track(
      directSessionReq(
        "sessions.patch",
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        {
          context: active.context,
        },
      ),
    );
    const archived = await racePromiseWithAbortSignal(archive, signal);
    expect(active.controller.signal.aborted).toBe(true);
    expect(archived.ok).toBe(false);
    expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  }));

test("sessions.patch rejects main and global archives before cancellation side effects", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("session-main") } });
  embeddedRunMock.activeIds.add("session-main");

  const main = await directSessionReq("sessions.patch", { key: "main", archived: true });
  expect(main.ok).toBe(false);
  expect(main.error?.message).toContain("main session");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoSessionQueueCleanup();
  expect(loadSessionEntry({ storePath, sessionKey: "main" })?.archivedAt).toBeUndefined();

  const globalFixture = await createConfiguredGlobalAgentSessionStore();
  try {
    embeddedRunMock.activeIds.add("sess-main-global");
    const global = await directSessionReq("sessions.patch", {
      key: "global",
      agentId: "main",
      archived: true,
    });
    expect(global.ok).toBe(false);
    expect(global.error?.message).toContain("main session");
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expectNoSessionQueueCleanup();
  } finally {
    await resetConfiguredGlobalAgentSessionStore(globalFixture);
  }
});

test("sessions.patch rejects unknown without materializing a session entry", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: {} });

  const archived = await directSessionReq("sessions.patch", { key: "unknown", archived: true });

  expect(archived.ok).toBe(false);
  expect(archived.error?.message).toContain("unknown session sentinel");
  expect(loadSessionEntry({ storePath, sessionKey: "unknown" })).toBeUndefined();
  expectNoSessionQueueCleanup();
});

test("sessions.patchMany prepares independent archive drains concurrently and releases in target order", ({
  signal,
}) =>
  withArchiveCleanup(signal, async ({ track, releaseOnAbort }) => {
    const { storePath } = await createSessionStoreDir();
    const firstKey = "agent:main:archive-batch-concurrent-first";
    const secondKey = "agent:main:archive-batch-concurrent-second";
    const firstSessionId = "session-batch-concurrent-first";
    const secondSessionId = "session-batch-concurrent-second";
    await writeSessionStore({
      entries: {
        [firstKey]: sessionStoreEntry(firstSessionId),
        [secondKey]: sessionStoreEntry(secondSessionId),
      },
    });
    const firstDrained = createDeferredCore();
    const firstStarted = createDeferredCore();
    const secondStarted = createDeferredCore();
    const firstRelease = vi.fn();
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
      directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
        "sessions.patchMany",
        {
          targets: [
            archiveTarget(firstKey, firstSessionId),
            archiveTarget(secondKey, secondSessionId),
          ],
          patch: { archived: true },
        },
        {
          context: {
            workerEnvironmentService: createWorkerInferenceDrainService(beginInferenceSessionDrain),
          },
        },
      ),
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
    expect(result.payload?.outcomes).toEqual([
      { key: firstKey, ok: true },
      { key: secondKey, ok: true },
    ]);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(firstRelease.mock.invocationCallOrder[0]).toBeLessThan(
      secondRelease.mock.invocationCallOrder[0]!,
    );
    expectArchived(storePath, firstKey);
    expectArchived(storePath, secondKey);
  }));

test("sessions.patchMany attempts every archive drain release without masking success", async () => {
  const { storePath } = await createSessionStoreDir();
  const firstKey = "agent:main:archive-release-throws-first";
  const secondKey = "agent:main:archive-release-after-throw";
  const firstSessionId = "session-archive-release-throws-first";
  const secondSessionId = "session-archive-release-after-throw";
  await writeSessionStore({
    entries: {
      [firstKey]: sessionStoreEntry(firstSessionId),
      [secondKey]: sessionStoreEntry(secondSessionId),
    },
  });
  const firstRelease = vi.fn(() => {
    throw new Error("release failed");
  });
  const secondRelease = vi.fn();

  const result = await directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
    "sessions.patchMany",
    {
      targets: [archiveTarget(firstKey, firstSessionId), archiveTarget(secondKey, secondSessionId)],
      patch: { archived: true },
    },
    {
      context: {
        workerEnvironmentService: createWorkerInferenceDrainService(
          vi.fn((sessionId: string) => ({
            drained: Promise.resolve(),
            hasWork: () => false,
            release: sessionId === firstSessionId ? firstRelease : secondRelease,
          })),
        ),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    { key: firstKey, ok: true },
    { key: secondKey, ok: true },
  ]);
  expect(firstRelease).toHaveBeenCalledOnce();
  expect(secondRelease).toHaveBeenCalledOnce();
  expectArchived(storePath, firstKey);
  expectArchived(storePath, secondKey);
});

test("sessions.patchMany isolates a failed archive drain and continues later targets", async () => {
  const { storePath } = await createSessionStoreDir();
  const stuckKey = "agent:main:archive-batch-stuck";
  const idleKey = "agent:main:archive-batch-after-stuck";
  const stuckSessionId = "session-batch-stuck";
  const idleSessionId = "session-batch-after-stuck";
  await writeSessionStore({
    entries: {
      [stuckKey]: sessionStoreEntry(stuckSessionId),
      [idleKey]: sessionStoreEntry(idleSessionId),
    },
  });
  embeddedRunMock.activeIds.add(stuckSessionId);
  embeddedRunMock.waitResults.set(stuckSessionId, false);

  const result = await directSessionReq<{
    outcomes: Array<{ error?: { code: string; retryable?: boolean }; key: string; ok: boolean }>;
  }>("sessions.patchMany", {
    targets: [archiveTarget(stuckKey, stuckSessionId), archiveTarget(idleKey, idleSessionId)],
    patch: { archived: true },
  });

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

test("sessions.patch rejects a generation replaced after the exact preparation read", ({
  signal,
}) =>
  withArchiveCleanup(signal, async ({ track, releaseOnAbort, dispose }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:archive-generation-race";
    const sessionId = "session-archive-generation-race";
    const runId = "run-archive-generation-race";
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    const persistence = createDeferredCore();
    const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
    dispose(active.unsubscribe);
    let placement = workerPlacement({ sessionId, sessionKey, state: "active" });
    const dispatch = vi.fn();
    const reclaim = vi.fn(async () => {
      placement = workerPlacement({ sessionId, sessionKey, state: "reclaimed" });
      return placement as Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
    });
    releaseOnAbort(() => persistence.resolve());
    const archive = track(
      directSessionReq(
        "sessions.patch",
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        {
          context: {
            ...active.context,
            workerSessionPlacementService: placementReader(() => placement),
            workerPlacementDispatchService: { dispatch, reclaim },
          },
        },
      ),
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
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      sessionId: "session-archive-generation-replacement",
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(reclaim).not.toHaveBeenCalled();
    expect(placement.state).toBe("active");
    expect(dispatch).not.toHaveBeenCalled();
  }));
