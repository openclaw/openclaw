import { setImmediate } from "node:timers/promises";
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
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  beginSessionEffect,
  closeSessionControllerAdmission,
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
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";
import {
  REQUEST as FIXTURE_REQUEST,
  seedActivePlacement,
  seedProvisioningPlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { placementSource } from "./worker-environments/placement-suite.test-support.js";
import { deriveEnvironmentIntent } from "./worker-environments/service-contract.js";
import * as support from "./worker-environments/service.test-support.js";
import type { WorkerSessionWorkspace } from "./worker-environments/session-workspace.js";

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

  it.each(["local", "recovery", "activation", "move"] as const)(
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
          runRecoveryBarrier: (request) =>
            pause(() =>
              options.runRecoveryBarrier({
                ...request,
                run: async (recoveryWorkspace: WorkerSessionWorkspace) => {
                  events.push("phase-started");
                  await request.run(recoveryWorkspace);
                },
              }),
            ),
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
        phase === "recovery"
          ? await harness.placements.seedProvisioning("remote-exec")
          : phase === "move"
            ? await harness.placements.seedActive(2, "remote-exec")
            : undefined;
      const operation = (
        phase === "recovery" && initial?.state === "provisioning"
          ? runtime.dispatchService.resumeProvisioning(initial, async () => {})
          : phase === "move" && initial?.state === "active"
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

  it("shutdown cancels recovery queued behind a session mutation before provider entry", async () => {
    const mutationEntered = createPlacementTestHold();
    const admissionTargetReady = createDeferredCore();
    const targetReader = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    moveDestinationMocks.prepareGatewaySessionTarget.mockImplementation(async (params) => {
      const target = await targetReader.resolveGatewaySessionStoreTargetInWorker(params);
      admissionTargetReady.resolve();
      return target;
    });
    const provider = support.createProvider();
    vi.spyOn(provider, "provision");
    vi.spyOn(provider, "destroy");
    const environments = support.createService(provider);
    const environment = await support.seedBootstrapping("environment-shutdown-queued-recovery");
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    await seedProvisioningPlacement(placements, environment.environmentId, "remote-exec");
    const runtime = await createRuntime(placements, environments);
    const uninstall = installWorkerPlacementReconcileGuard({
      placements,
      environments,
      dispatch: runtime.dispatchService,
      isStopping: environments.isStopping,
    });
    const mutation = runSessionMutation({
      ...sessionIdentity(),
      prepare: async () => {
        await mutationEntered.wait();
      },
      run: async () => {},
    });
    let recovery: Promise<unknown> = Promise.resolve();
    let stopping: Promise<unknown> = Promise.resolve();
    try {
      await mutationEntered.entered.promise;
      recovery = environments.reconcileEnvironment(environment.environmentId).catch(captureError);
      await waitForBoundary(
        admissionTargetReady.promise,
        recovery,
        "Recovery ended before session admission",
      );
      let stopped = false;
      environments.beginClose();
      stopping = environments.stop().then(() => {
        stopped = true;
      });
      // Shutdown must release queued recovery without waiting for the unrelated mutation.
      await support.waitForFast(() => expect(stopped).toBe(true));
      await recovery;
      expect(provider.provision).not.toHaveBeenCalled();
      expect(provider.destroy).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
      expect(support.testState.store.get(environment.environmentId)).toMatchObject({
        state: "bootstrapping",
        leaseId: environment.leaseId,
        destroyRequestedAtMs: null,
      });
    } finally {
      mutationEntered.release.resolve();
      await Promise.allSettled([mutation, recovery, stopping]);
      await uninstall();
    }
  });

  it.each([
    "replaced",
    "archived",
    "archived-behind-same-session-destroy",
    "shutdown",
    "closed-ingress",
    "started-failure",
  ] as const)(
    "preserves the exact recovery cleanup owner after %s admission refusal",
    async (reason) => {
      const destroyEntered = createPlacementTestHold();
      const exclusiveEntered = createPlacementTestHold();
      const invalidOwner = reason === "replaced" || reason.startsWith("archived");
      const destroy = vi.fn(
        async ({
          leaseId,
        }: Parameters<ReturnType<typeof support.createProvider>["destroy"]>[0]) => {
          if (leaseId === "lease:environment-prior-exclusive") {
            await exclusiveEntered.wait();
            return;
          }
          await destroyEntered.wait();
        },
      );
      const provision = vi.fn(async () => {
        throw new Error("Refused recovery must not replay provisioning");
      });
      const environments = support.createService(support.createProvider({ provision, destroy }));
      const environment = await support.seedBootstrapping("environment-refused-recovery");
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      await seedProvisioningPlacement(placements, environment.environmentId, "remote-exec");
      const entry = {
        sessionId: reason === "replaced" ? "replacement-session" : REQUEST.sessionId,
        lifecycleRevision: "original",
        worktree: { id: "workspace", branch: "fixture", repoRoot: support.testState.root },
        ...(reason.startsWith("archived") ? { archivedAt: 1 } : {}),
      };
      await upsertSessionEntryCore(
        {
          agentId: REQUEST.agentId,
          sessionKey: REQUEST.sessionKey,
          storePath: moveDestinationMocks.resolveGatewaySessionTarget().storePath,
        },
        entry,
      );
      moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
      if (reason === "started-failure") {
        vi.mocked(support.testState.bootstrapWorker).mockRejectedValueOnce(
          new Error("Bootstrap failed"),
        );
      }
      const runtime = await createRuntime(placements, environments);
      const uninstall = installWorkerPlacementReconcileGuard({
        placements,
        environments,
        dispatch: runtime.dispatchService,
        isStopping: () => false,
      });
      let exclusive: Promise<unknown> = Promise.resolve();
      if (reason === "archived-behind-same-session-destroy") {
        const previous = await support.seedReady("environment-prior-exclusive");
        await environments.attachSession({
          environmentId: previous.environmentId,
          ownerEpoch: previous.ownerEpoch,
          sessionId: REQUEST.sessionId,
        });
        exclusive = runtime.dispatchService.forceDestroyEnvironment("environment-prior-exclusive");
        await waitForBoundary(
          exclusiveEntered.entered.promise,
          exclusive,
          "Prior exclusive operation ended before its held provider",
        );
      }
      const releaseIngress =
        reason === "closed-ingress"
          ? closeSessionControllerAdmission({
              ...sessionIdentity(),
              reason: new Error("session cancellation owns ingress"),
            })
          : () => {};
      if (reason === "shutdown") {
        markGatewayRestartDraining();
      }
      let settled = false;
      const recovery = environments.reconcileEnvironment(environment.environmentId).then(
        () => {
          settled = true;
          return "settled";
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        if (reason === "archived-behind-same-session-destroy") {
          await setImmediate();
          expect(destroy).toHaveBeenCalledExactlyOnceWith({
            leaseId: "lease:environment-prior-exclusive",
            profile: { region: "test" },
          });
          expect(settled).toBe(false);
          exclusiveEntered.release.resolve();
          await exclusive;
        }
        const first = await Promise.race([
          destroyEntered.entered.promise.then(() => "destroy-started"),
          recovery,
        ]);
        expect(provision).not.toHaveBeenCalled();
        if (reason !== "started-failure") {
          expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
        }
        if (invalidOwner || reason === "started-failure") {
          expect(first).toBe("destroy-started");
          expect(settled).toBe(false);
          expect(
            destroy.mock.calls.filter(([lease]) => lease.leaseId === environment.leaseId),
          ).toEqual([[{ leaseId: environment.leaseId, profile: { region: "test" } }]]);
          const interruption = startSessionControllerInterruption(sessionIdentity());
          const admissionReleased = vi.fn();
          void interruption.released.then(admissionReleased);
          if (reason === "started-failure") {
            await setImmediate();
            expect(admissionReleased).not.toHaveBeenCalled();
          }
          destroyEntered.release.resolve();
          await recovery;
          await interruption.released;
          expect(placements.get(REQUEST.sessionId)).toMatchObject({
            state: "failed",
            environmentId: environment.environmentId,
          });
          expect(support.testState.store.get(environment.environmentId)?.state).toBe(
            reason === "started-failure" ? "failed" : "destroyed",
          );
        } else {
          // Shutdown skips reconciliation before admission and preserves recovery state.
          expect(first).toEqual(reason === "shutdown" ? "settled" : expect.any(Error));
          expect(destroy).not.toHaveBeenCalled();
          expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
          expect(support.testState.store.get(environment.environmentId)).toMatchObject({
            state: "bootstrapping",
            leaseId: environment.leaseId,
            destroyRequestedAtMs: null,
          });
        }
      } finally {
        exclusiveEntered.release.resolve();
        destroyEntered.release.resolve();
        releaseIngress();
        resetGatewayWorkAdmission();
        await Promise.allSettled([recovery, exclusive]);
        await uninstall();
      }
    },
  );

  it.each(["targeted", "sweep", "idle", "late-sweep", "timeout"] as const)(
    "Stop owns steady-state provisioning through %s recovery ordering",
    async (mode) => {
      if (mode === "timeout") {
        // Seed the durable provisioning state before expiring the held provider replay.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const replayEntered = createPlacementTestHold();
      const stopPrepared = createDeferredCore();
      const sweepEntered = createDeferredCore();
      const enterSweep = createDeferredCore();
      let providerSignal: AbortSignal | undefined;
      let provisionCalls = 0;
      const events: string[] = [];
      const destroy = vi.fn(async () => {
        events.push("destroy");
      });
      const environments = support.createService(
        support.createProvider({
          provision: async (_profile, _operation, options) => {
            provisionCalls += 1;
            if (provisionCalls <= 2) {
              throw new Error("provider reply unavailable after allocation");
            }
            providerSignal = options?.signal;
            events.push("replay");
            await replayEntered.wait();
            events.push("child-closed");
            return { leaseId: "lease-recovery-stop", ssh: support.SSH_ENDPOINT, sharedHost: false };
          },
          resolveAllocation: async () => ({ leaseId: "lease-recovery-stop", sharedHost: false }),
          destroy,
        }),
        mode === "timeout" ? { providerCallTimeoutMs: 20 } : {},
      );
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const requested = await placements.startDispatch(REQUEST);
      const key = `session-dispatch:${REQUEST.sessionId}:${requested.generation}`;
      const intent = deriveEnvironmentIntent(key);
      await placements.transition({
        sessionId: REQUEST.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: intent.environmentId },
      });
      await expect(
        environments.createWithRequest({
          profileId: "development",
          idempotencyKey: key,
          executionMode: REQUEST.executionMode,
        }),
      ).rejects.toMatchObject({ code: "provider_failure" });
      const cancel = vi.fn(cancelSessionWork);
      if (mode === "late-sweep") {
        // Recovery captures service methods when its runtime is created.
        const reconcileOnce = environments.reconcileOnce.bind(environments);
        vi.spyOn(environments, "reconcileOnce").mockImplementationOnce(async () => {
          sweepEntered.resolve();
          await enterSweep.promise;
          await reconcileOnce();
        });
      }
      const runtime = await createRuntime(placements, environments, cancel);
      const uninstallGuard = installWorkerPlacementReconcileGuard({
        placements,
        environments,
        dispatch: runtime.dispatchService,
        isStopping: () => false,
      });
      // A completed recovery pass leaves this durable operation retryable. This is the
      // same installed guard used after startup unlocks, not an RPC through the startup gate.
      await environments.reconcileEnvironment(intent.environmentId);
      expect(provisionCalls).toBe(2);
      expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
      const recovery =
        mode === "idle"
          ? Promise.resolve()
          : mode === "targeted"
            ? environments.reconcileEnvironment(intent.environmentId)
            : runtime.dispatchService.reconcileActive();
      if (mode !== "idle") {
        await waitForBoundary(
          mode === "late-sweep" ? sweepEntered.promise : replayEntered.entered.promise,
          recovery,
          "Recovery returned before its held boundary",
        );
      }
      if (mode === "timeout") {
        // Startup and sweep completion use the caller result, but Stop must still
        // reach the actual provider that outlives that timeout.
        await vi.advanceTimersByTimeAsync(20);
        await recovery;
        expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
        expect(events).toEqual(["replay"]);
      }
      const attach = vi.spyOn(environments, "attachSession");
      const stopIntentCommitted = createDeferredCore();
      const requestDestroy = support.testState.store.requestDestroy.bind(support.testState.store);
      vi.spyOn(support.testState.store, "requestDestroy").mockImplementation(async (request) => {
        const record = await requestDestroy(request);
        if (record.environmentId === intent.environmentId) {
          stopIntentCommitted.resolve();
        }
        return record;
      });
      let stopped = false;
      const stopping = runtime.dispatchService
        .reclaim(REQUEST, undefined, () => stopPrepared.resolve())
        .then(
          (value) => {
            stopped = true;
            return value;
          },
          (error: unknown) => {
            stopped = true;
            return error;
          },
        );
      try {
        await waitForBoundary(stopPrepared.promise, stopping, "Stop ended before preparation");
        if (mode === "idle" || mode === "late-sweep") {
          // Stop has closed ingress before the older sweep discovers its recovery.
          // That recovery cannot wait for this Stop or allocate after it completes.
          enterSweep.resolve();
          expect(await stopping).toMatchObject({ state: "local" });
          expect(stopped).toBe(true);
          expect(provisionCalls).toBe(2);
        } else {
          await waitForBoundary(
            stopIntentCommitted.promise,
            stopping,
            "Stop ended before committing its destroy intent",
          );
          expect(providerSignal?.aborted).toBe(true);
          expect(cancel).toHaveBeenCalledOnce();
          expect(stopped).toBe(false);
          expect(destroy).not.toHaveBeenCalled();
          expect(
            support.testState.store.get(intent.environmentId)?.destroyRequestedAtMs,
          ).not.toBeNull();
        }
      } finally {
        enterSweep.resolve();
        replayEntered.release.resolve();
        await Promise.allSettled([recovery, stopping]);
        await uninstallGuard();
      }
      expect(await stopping).toMatchObject({ state: "local" });
      expect(events).toEqual(
        mode === "idle" || mode === "late-sweep"
          ? ["destroy"]
          : ["replay", "child-closed", "destroy"],
      );
      expect(attach).not.toHaveBeenCalled();
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-recovery-stop",
      });
    },
  );
});
