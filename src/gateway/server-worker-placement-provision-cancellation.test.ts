import { describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";
import {
  publishWorkerEnvironmentFixture,
  seedAttachedPlacementEnvironment,
} from "./worker-environments/placement-test-fixtures.js";

const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));

import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  beginSessionEffect,
  runSessionMutation,
  startSessionControllerInterruption,
} from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import {
  createPlacementTestHold,
  waitForPlacementBoundary as waitForBoundary,
} from "./server-worker-placement-hold.test-support.js";
import {
  createHeldWorkspacePreflight,
  createRuntime,
  setupSessionFixture,
} from "./server-worker-placement-provision-cancellation.test-support.js";
import {
  REQUEST as FIXTURE_REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { placementSource } from "./worker-environments/placement-suite.test-support.js";
import * as support from "./worker-environments/service.test-support.js";

const REQUEST = {
  ...FIXTURE_REQUEST,
  profileId: "development",
  executionMode: "remote-exec" as const,
};

const sessionIdentity = (scope = `${support.testState.root}/sessions.sqlite`) => ({
  agentId: REQUEST.agentId,
  scope,
  identities: [REQUEST.sessionKey, REQUEST.sessionId],
});
const captureError = (error: unknown) => error;
const cancelSessionWork: WorkerPlacementSessionWorkCancellation = async (request) => {
  request.assertCurrent();
  request.onCancellationStarted?.();
};

describe("dispatch Stop before provider allocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  setupSessionFixture(REQUEST);

  it.each([
    { identity: REQUEST.sessionKey, inherited: false },
    { identity: REQUEST.sessionId, inherited: false },
    { identity: "legacy-session-alias", inherited: false },
    { identity: REQUEST.sessionKey, inherited: true },
  ])("preserves active $identity work (inherited: $inherited)", async ({ identity, inherited }) => {
    const targetReader = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    moveDestinationMocks.prepareGatewaySessionTarget.mockImplementation((params) =>
      targetReader.resolveGatewaySessionStoreTargetInWorker({
        ...params,
        onSelected: (target) => {
          target.storeKeys.push("legacy-session-alias");
          params.onSelected?.(target);
        },
      }),
    );
    workspace.preflight.mockReset().mockResolvedValue(undefined);
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const environments = support.createService(support.createProvider());
    vi.spyOn(environments, "prepareProjectIntent").mockRejectedValue(
      new Error("fixture: barrier complete"),
    );
    const allocate = vi.spyOn(environments, "createWithRequest");
    const start = vi.spyOn(placements, "startDispatch");
    const runtime = await createRuntime(placements, environments);
    const interrupted = vi.fn();
    const admission = await beginSessionEffect({
      agentId: REQUEST.agentId,
      scope: `${support.testState.root}/sessions.sqlite`,
      identities: [identity],
      assertAllowed: () => {},
      onInterrupt: () => {
        interrupted();
        admission.release();
      },
    });
    const dispatch = () => runtime.dispatchService.dispatch(REQUEST);
    try {
      if (inherited) {
        await expect(admission.run(dispatch)).rejects.toThrow("fixture: barrier complete");
        expect(start).toHaveBeenCalledOnce();
      } else {
        await expect(dispatch()).rejects.toThrow("is busy with active work");
        expect(workspace.preflight).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(await placements.getAsync(REQUEST.sessionId)).toBeUndefined();
      }
      expect(interrupted).not.toHaveBeenCalled();
      expect(admission.isActive()).toBe(true);
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
    if (!inherited) {
      await expect(dispatch()).rejects.toThrow("fixture: barrier complete");
      expect(start).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { targetKind: "profile", outcome: "cancel" },
    { targetKind: "device", outcome: "cancel" },
    { targetKind: "profile", outcome: "preflight-error" },
    { targetKind: "profile", outcome: "canceled-preflight-error" },
    { targetKind: "profile", outcome: "replacement" },
    { targetKind: "profile", outcome: "incarnation" },
    { targetKind: "profile", outcome: "published" },
  ] as const)(
    "Stop settles Move at destination admission ($targetKind, $outcome)",
    async ({ targetKind, outcome }) => {
      const actual = await vi.importActual<
        typeof import("./worker-environments/placement-dispatch.js")
      >("./worker-environments/placement-dispatch.js");
      const targetOwner = await vi.importActual<
        typeof import("./server-worker-placement-session-target.js")
      >("./server-worker-placement-session-target.js");
      moveDestinationMocks.resolveSessionTarget.mockImplementation(
        targetOwner.resolveWorkerPlacementSessionTarget,
      );
      const sourceEntry = moveDestinationMocks.resolveCanonicalSession();
      const sessionTarget = moveDestinationMocks.resolveGatewaySessionTarget();
      const { storePath } = sessionTarget;
      await upsertSessionEntryCore(
        { agentId: REQUEST.agentId, sessionKey: REQUEST.sessionKey, storePath },
        {
          ...sourceEntry,
          worktree: {
            ...sourceEntry.worktree,
            branch: "synthetic",
            repoRoot: support.testState.root,
          },
        },
      );
      runtimeFactoryMocks.createDispatch.mockImplementation((options) =>
        actual.createWorkerPlacementDispatchService({
          ...options,
          resolveMoveDestination: async (_identity, target) =>
            target.kind === "gateway"
              ? undefined
              : {
                  profileId:
                    target.kind === "profile" ? target.profileId : `device:${target.deviceId}`,
                  executionMode: "remote-exec",
                  ...(target.kind === "device" ? { deviceId: target.deviceId } : {}),
                },
        }),
      );
      const entered = createPlacementTestHold();
      const destinationAborted = createDeferredCore();
      let destinationSignal: AbortSignal | undefined;
      workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
        if (outcome === "published") {
          return;
        }
        destinationSignal = signal;
        signal?.addEventListener("abort", () => destinationAborted.resolve(), { once: true });
        await entered.wait();
        if (outcome === "preflight-error" || outcome === "canceled-preflight-error") {
          throw new Error("destination preflight rejected");
        }
        signal?.throwIfAborted();
      });
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = await createHarness(support.testState.stateDb, placements, {
        workspacePath: support.testState.root,
      });
      const active = await harness.placements.seedActive(2, "remote-exec");
      if (active.state !== "active") {
        throw new Error("Move fixture requires an active source");
      }
      harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);

      if (outcome === "published") {
        vi.mocked(harness.environments.createWithRequest).mockImplementation(async ({ signal }) => {
          destinationSignal = signal;
          signal?.addEventListener("abort", () => destinationAborted.resolve(), { once: true });
          await entered.wait();
          signal?.throwIfAborted();
          throw new Error("published destination must be canceled");
        });
      }
      const environments = {
        ...support.createService(support.createProvider()),
        ...harness.environments,
      };
      const runtime = await createRuntime(placements, environments, cancelSessionWork);
      const transitions: Array<{ state: string; generation: number }> = [];
      const moving = runtime.dispatchService
        .move(
          {
            ...REQUEST,
            source: placementSource(active),
            target:
              targetKind === "profile"
                ? { kind: "profile", profileId: "development" }
                : { kind: "device", deviceId: "destination-device" },
          },
          (placement) =>
            transitions.push({ state: placement.state, generation: placement.generation }),
        )
        .catch(captureError);
      let stopping: Promise<unknown> = Promise.resolve();
      try {
        await waitForBoundary(entered.entered.promise, moving);
        const local = transitions.find((placement) => placement.state === "local");
        expect(local).toBeDefined();
        expect(placements.get(REQUEST.sessionId)?.state).toBe(
          outcome === "published" ? "provisioning" : "local",
        );
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
        if (outcome !== "preflight-error") {
          stopping = runtime.dispatchService.reclaim(REQUEST).catch(captureError);
          await waitForBoundary(destinationAborted.promise, stopping);
          expect(destinationSignal?.aborted).toBe(true);
          if (outcome === "replacement") {
            await placements.startDispatch(REQUEST);
          } else if (outcome === "incarnation") {
            sourceEntry.sessionId = "replacement-session";
            await upsertSessionEntryCore(
              { agentId: REQUEST.agentId, sessionKey: REQUEST.sessionKey, storePath },
              sourceEntry,
            );
          }
        }
        entered.release.resolve();
        const moved = await moving;
        const stopped = await stopping;
        if (outcome === "cancel" || outcome === "incarnation") {
          expect.soft(moved).toMatchObject({ state: "local", generation: local?.generation });
          expect.soft(await placements.getPlacementMoveAsync(REQUEST.sessionId)).toBeUndefined();
          if (outcome === "incarnation") {
            // Move reports the old source's committed cleanup; Stop cannot use that
            // completion as authority over the replacement session incarnation.
            expect(stopped).toMatchObject({ code: "invalid_state" });
            expect(sourceEntry.sessionId).toBe("replacement-session");
            expect(await placements.getAsync("replacement-session")).toBeUndefined();
          } else {
            expect.soft(stopped).toMatchObject({ state: "local", generation: local?.generation });
          }
        } else {
          expect(moved).toBeInstanceOf(Error);
          if (outcome === "preflight-error" || outcome === "canceled-preflight-error") {
            expect(moved).toMatchObject({ message: "destination preflight rejected" });
            expect((await placements.getPlacementMoveAsync(REQUEST.sessionId))?.lastError).toBe(
              "destination preflight rejected",
            );
            if (outcome === "canceled-preflight-error") {
              expect(stopped).toBeInstanceOf(Error);
              expect(moved).not.toBe(destinationSignal?.reason);
            }
          } else if (outcome === "published") {
            expect(stopped).toMatchObject({ state: "local" });
            expect(placements.get(REQUEST.sessionId)!.generation).toBeGreaterThan(
              local!.generation,
            );
          } else {
            expect(stopped).toBeInstanceOf(Error);
          }
        }
        expect(harness.environments.createWithRequest).toHaveBeenCalledTimes(
          outcome === "published" ? 1 : 0,
        );
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      } finally {
        entered.release.resolve();
        await Promise.allSettled([moving, stopping]);
        await runSessionMutation({
          ...sessionIdentity(sessionTarget.storePath),
          run: async () => {},
        });
      }
    },
  );

  it("cancels the exact preflight owner without admitting a later provider", async () => {
    const preflight = createHeldWorkspacePreflight();
    workspace.preflight.mockImplementation(preflight.run);
    const provision = vi.fn(async () => {
      throw new Error("unexpected provider entry");
    });
    const environments = support.createService(support.createProvider({ provision }));
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const runtime = await createRuntime(placements, environments);
    const dispatch = runtime.dispatchService.dispatch(REQUEST).catch((error: unknown) => error);
    await preflight.entered;
    expect(await placements.getAsync(REQUEST.sessionId)).toBeUndefined();
    const stopping = runtime.dispatchService.reclaim(REQUEST);
    let stopped = false;
    void stopping.then(
      () => {
        stopped = true;
      },
      () => {},
    );
    try {
      await Promise.race([
        preflight.aborted,
        stopping.then(() => {
          throw new Error("Stop settled before interrupting the held preflight");
        }),
      ]);
      expect(preflight.signal?.aborted).toBe(true);
      expect(stopped).toBe(false);
      expect(provision).not.toHaveBeenCalled();
    } finally {
      preflight.release();
      await dispatch;
      await stopping.catch(() => undefined);
    }
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });
  it.each(["missing", "reclaimed"] as const)(
    "cancels redispatch from a %s placement before allocation during reconciliation",
    async (state) => {
      const preflight = createHeldWorkspacePreflight();
      workspace.preflight.mockImplementation(preflight.run);
      const environments = support.createService(support.createProvider());
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      if (state === "reclaimed") {
        seedAttachedPlacementEnvironment(support.testState.stateDb, {
          environmentId: "old-environment",
          sessionId: REQUEST.sessionId,
          ownerEpoch: 1,
        });
        const active = await seedActivePlacement(placements, {
          environmentId: "old-environment",
          ownerEpoch: 1,
          executionMode: "remote-exec",
        });
        const source = {
          sessionId: REQUEST.sessionId,
          environmentId: "old-environment",
          ownerEpoch: 1,
        };
        const draining = await placements.startDrain({
          ...source,
          expectedGeneration: active.generation,
        });
        await placements.startReconcile({
          ...source,
          expectedGeneration: draining.generation,
        });
        const current = placements.get(REQUEST.sessionId)!;
        await placements.transition({
          sessionId: REQUEST.sessionId,
          from: "reconciling",
          to: "reclaimed",
          expectedGeneration: current.generation,
        });
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare("DELETE FROM worker_environments WHERE environment_id = ?").run(
              "old-environment",
            );
            publishWorkerEnvironmentFixture(db, "old-environment");
          },
          { database: support.testState.stateDb },
        );
      }
      const entered = createPlacementTestHold();
      vi.spyOn(environments, "reconcileOnce").mockImplementation(async () => {
        await entered.wait();
      });
      const create = vi.spyOn(environments, "createWithRequest");
      const runtime = await createRuntime(placements, environments);
      const sweep = runtime.dispatchService.reconcileActive();
      await entered.entered.promise;
      const dispatch = runtime.dispatchService.dispatch(REQUEST).then(
        () => "active",
        () => "cancelled",
      );
      let stopping: Promise<unknown> | undefined;
      try {
        await Promise.race([
          preflight.entered,
          dispatch.then((result) => {
            throw new Error(`Redispatch ended before preflight (${result})`);
          }),
        ]);
        expect((await placements.getAsync(REQUEST.sessionId))?.state).toBe(
          state === "missing" ? undefined : "reclaimed",
        );
        stopping = runtime.dispatchService.reclaim(REQUEST).catch(captureError);
        await waitForBoundary(preflight.aborted, stopping);
        expect(preflight.signal?.aborted).toBe(true);
        expect(create).not.toHaveBeenCalled();
        preflight.release();
        entered.release.resolve();
        await sweep;
        expect(await dispatch).toBe("cancelled");
        const result = await stopping;
        if (state === "reclaimed") {
          expect(result).toMatchObject({ state: "reclaimed" });
        } else {
          expect(result).toBeInstanceOf(Error);
        }
        expect(create).not.toHaveBeenCalled();
        expect(support.testState.store.list()).toEqual([]);
      } finally {
        preflight.release();
        entered.release.resolve();
        await Promise.allSettled([sweep, dispatch, stopping]);
      }
    },
  );

  it.each(["local", "activation", "move"] as const)(
    "releases admitted %s queued behind an interrupting lifecycle owner",
    async (phase) => {
      const actual = await vi.importActual<
        typeof import("./worker-environments/placement-dispatch.js")
      >("./worker-environments/placement-dispatch.js");
      const beforeBarrier = createPlacementTestHold();
      const queued = createDeferredCore();
      const mutationEntered = createDeferredCore();
      const interrupt = createDeferredCore();
      const releaseMutation = createDeferredCore();
      const events: string[] = [];
      let observeQueue = false;
      const target = moveDestinationMocks.resolveGatewaySessionTarget();
      const targetReader = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
        "./session-utils-store-worker.js",
      );
      moveDestinationMocks.prepareGatewaySessionTarget.mockImplementation(async (params) => {
        const prepared = await targetReader.resolveGatewaySessionStoreTargetInWorker(params);
        if (observeQueue) {
          queued.resolve();
        }
        return prepared;
      });
      const pause = async <T>(run: () => Promise<T>): Promise<T> => {
        await beforeBarrier.wait();
        return await run();
      };
      runtimeFactoryMocks.createDispatch.mockImplementation((options) =>
        actual.createWorkerPlacementDispatchService({
          ...options,
          runLocalBarrier: (request) =>
            phase === "local"
              ? pause(() =>
                  options.runLocalBarrier({
                    ...request,
                    startDispatch: () => {
                      events.push("phase-started");
                      return request.startDispatch();
                    },
                  }),
                )
              : options.runLocalBarrier(request),
          runActivationBarrier: (request) =>
            phase === "activation"
              ? pause(() =>
                  options.runActivationBarrier({
                    ...request,
                    activate: (assertCurrent?: () => void) => {
                      events.push("phase-started");
                      return request.activate(assertCurrent);
                    },
                  }),
                )
              : options.runActivationBarrier(request),
          runMoveBarrier: (request) =>
            pause(() =>
              options.runMoveBarrier({
                ...request,
                begin: async (prepareNew?: (runId: string) => Promise<void>) => {
                  events.push("phase-started");
                  return await request.begin(prepareNew);
                },
              }),
            ),
        }),
      );
      workspace.preflight.mockResolvedValue(undefined);
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = await createHarness(support.testState.stateDb, placements);
      const environments = {
        ...support.createService(support.createProvider()),
        ...harness.environments,
      };
      const runtime = await createRuntime(placements, environments);
      const initial =
        phase === "move" ? await harness.placements.seedActive(2, "remote-exec") : undefined;
      const operation = (
        initial?.state === "active"
          ? runtime.dispatchService.move({
              ...REQUEST,
              source: placementSource(initial),
              target: { kind: "gateway" },
            })
          : runtime.dispatchService.dispatch(REQUEST)
      ).catch(captureError);
      await waitForBoundary(
        beforeBarrier.entered.promise,
        operation,
        "Placement operation ended before its lifecycle barrier",
      );
      const identity = sessionIdentity(target.storePath);
      // A task kill acquires this mutation outside the admitted operation's ALS,
      // then drains admissions while its own lifecycle mutation remains active.
      const mutation = runSessionMutation({
        ...identity,
        prepare: async () => {
          mutationEntered.resolve();
          await interrupt.promise;
          const { released } = startSessionControllerInterruption(identity);
          void released.then(() => events.push("admission-released"));
          await Promise.race([released, releaseMutation.promise]);
          await releaseMutation.promise;
        },
        run: async () => events.push("mutation-finished"),
      });
      try {
        await mutationEntered.promise;
        observeQueue = true;
        beforeBarrier.release.resolve();
        await queued.promise;
        interrupt.resolve();
        await support.waitForFast(() => expect(events).toEqual(["admission-released"]));
        expect(harness.log).not.toContain("placement:active");
      } finally {
        beforeBarrier.release.resolve();
        interrupt.resolve();
        releaseMutation.resolve();
        await Promise.allSettled([operation, mutation]);
        // Flush the canceled contender: it must never execute after its predecessor releases.
        await runSessionMutation({ ...identity, run: async () => {} });
      }
      expect(events).toEqual(["admission-released", "mutation-finished"]);
    },
  );
});
