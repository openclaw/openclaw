import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));

import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
  startSessionWorkAdmissionInterruption,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import {
  REQUEST as FIXTURE_REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { deriveEnvironmentIntent } from "./worker-environments/service-contract.js";
import * as support from "./worker-environments/service.test-support.js";

const REQUEST = {
  ...FIXTURE_REQUEST,
  profileId: "development",
  executionMode: "remote-exec" as const,
};

describe("dispatch Stop before provider allocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  beforeEach(async () => {
    const actual = await vi.importActual<
      typeof import("./worker-environments/placement-dispatch.js")
    >("./worker-environments/placement-dispatch.js");
    runtimeFactoryMocks.createDispatch.mockImplementation(
      actual.createWorkerPlacementDispatchService,
    );
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({ read: vi.fn(), version: () => 0 });
    const entry = {
      sessionId: REQUEST.sessionId,
      lifecycleRevision: "original",
      worktree: { id: "workspace" },
    };
    const target = {
      agentId: REQUEST.agentId,
      canonicalKey: REQUEST.sessionKey,
      store: { [REQUEST.sessionKey]: entry },
      storeKeys: [REQUEST.sessionKey],
      storePath: `${support.testState.root}/sessions.sqlite`,
    };
    const worktree = { id: "workspace", ownerId: REQUEST.sessionKey, path: support.testState.root };
    moveDestinationMocks.getRuntimeConfig.mockReturnValue(support.testState.config);
    moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValue(target);
    moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
    moveDestinationMocks.findManagedWorktree.mockReturnValue(worktree);
    moveDestinationMocks.resolveSessionTarget.mockReturnValue({
      config: support.testState.config,
      target,
      entry,
      worktree,
      workspace: { kind: "local", path: worktree.path },
    });
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
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const interrupted = createDeferredCore();
      let destinationSignal: AbortSignal | undefined;
      workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
        if (outcome === "published") {
          return;
        }
        destinationSignal = signal;
        entered.resolve();
        await release.promise;
        if (outcome === "preflight-error" || outcome === "canceled-preflight-error") {
          throw new Error("destination preflight rejected");
        }
        signal?.throwIfAborted();
      });
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = createHarness(support.testState.stateDb, placements, {
        workspacePath: support.testState.root,
      });
      const active = harness.placements.seedActive(2, "remote-exec");
      if (active.state !== "active") {
        throw new Error("Move fixture requires an active source");
      }
      harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);

      if (outcome === "published") {
        vi.mocked(harness.environments.create).mockImplementation(
          async (_profile, _key, _machine, _mode, _path, signal) => {
            destinationSignal = signal;
            entered.resolve();
            await release.promise;
            signal?.throwIfAborted();
            throw new Error("published destination must be canceled");
          },
        );
      }
      const environments = {
        ...support.createService(support.createProvider()),
        ...harness.environments,
      };
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork: async (request) => {
          request.assertCurrent();
          request.onCancellationStarted?.();
          interrupted.resolve();
        },
        revokeSessionAuthority: vi.fn(),
      });
      const sessionTarget = moveDestinationMocks.resolveGatewaySessionTarget();
      const sourceEntry = moveDestinationMocks.resolveCanonicalSession();
      const transitions: Array<{ state: string; generation: number }> = [];
      const moving = runtime.dispatchService
        .move(
          {
            ...REQUEST,
            source: {
              generation: active.generation,
              environmentId: active.environmentId,
              ownerEpoch: active.activeOwnerEpoch,
            },
            target:
              targetKind === "profile"
                ? { kind: "profile", profileId: "development" }
                : { kind: "device", deviceId: "destination-device" },
          },
          (placement) =>
            transitions.push({ state: placement.state, generation: placement.generation }),
        )
        .catch((error: unknown) => error);
      let stopping: Promise<unknown> = Promise.resolve();
      try {
        await Promise.race([
          entered.promise,
          moving.then((result) => {
            throw result;
          }),
        ]);
        const local = transitions.find((placement) => placement.state === "local");
        expect(local).toBeDefined();
        expect(placements.get(REQUEST.sessionId)?.state).toBe(
          outcome === "published" ? "provisioning" : "local",
        );
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
        if (outcome !== "preflight-error") {
          stopping = runtime.dispatchService.reclaim(REQUEST).catch((error: unknown) => error);
          await Promise.race([
            interrupted.promise,
            stopping.then((result) => {
              throw result;
            }),
          ]);
          expect(destinationSignal?.aborted).toBe(true);
          if (outcome === "replacement") {
            placements.startDispatch(REQUEST);
          } else if (outcome === "incarnation") {
            sourceEntry.sessionId = "replacement-session";
          }
        }
        release.resolve();
        const moved = await moving;
        const stopped = await stopping;
        if (outcome === "cancel" || outcome === "incarnation") {
          expect.soft(moved).toMatchObject({ state: "local", generation: local?.generation });
          expect.soft(placements.getPlacementMove(REQUEST.sessionId)).toBeUndefined();
          if (outcome === "incarnation") {
            // Move reports the old source's committed cleanup; Stop cannot use that
            // completion as authority over the replacement session incarnation.
            expect(stopped).toMatchObject({ code: "invalid_state" });
            expect(sourceEntry.sessionId).toBe("replacement-session");
            expect(placements.get("replacement-session")).toBeUndefined();
          } else {
            expect.soft(stopped).toMatchObject({ state: "local", generation: local?.generation });
          }
        } else {
          expect(moved).toBeInstanceOf(Error);
          if (outcome === "preflight-error" || outcome === "canceled-preflight-error") {
            expect(moved).toMatchObject({ message: "destination preflight rejected" });
            expect(placements.getPlacementMove(REQUEST.sessionId)?.lastError).toBe(
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
        expect(harness.environments.create).toHaveBeenCalledTimes(outcome === "published" ? 1 : 0);
        expect(placements.listPendingWorkspaceResults()).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([moving, stopping]);
        await runExclusiveSessionLifecycleMutation({
          scope: sessionTarget.storePath,
          identities: [REQUEST.sessionKey, REQUEST.sessionId],
          run: async () => {},
        });
      }
    },
  );

  it("cancels the exact preflight owner without admitting a later provider", async () => {
    const entered = createDeferredCore();
    const settled = createDeferredCore();
    let preflightSignal: AbortSignal | undefined;
    workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      preflightSignal = signal;
      entered.resolve();
      await settled.promise;
      signal?.throwIfAborted();
    });
    const provision = vi.fn(async () => {
      throw new Error("unexpected provider entry");
    });
    const environments = support.createService(support.createProvider({ provision }));
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const runtime = createGatewayWorkerPlacementRuntime({
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      warn: vi.fn(),
      cancelSessionWork: vi.fn(async () => {}),
      revokeSessionAuthority: vi.fn(),
    });
    const dispatch = runtime.dispatchService.dispatch(REQUEST).catch((error: unknown) => error);
    await entered.promise;
    expect(placements.get(REQUEST.sessionId)).toBeUndefined();
    const stopping = runtime.dispatchService.reclaim(REQUEST);
    let stopped = false;
    void stopping.then(
      () => {
        stopped = true;
      },
      () => {},
    );
    try {
      await setImmediate();
      await setImmediate();
      expect(preflightSignal?.aborted).toBe(true);
      expect(stopped).toBe(false);
      expect(provision).not.toHaveBeenCalled();
    } finally {
      settled.resolve();
      await dispatch;
      await stopping.catch(() => undefined);
    }
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });
  it.each(["missing", "reclaimed"] as const)(
    "cancels queued redispatch before the %s placement can allocate",
    async (state) => {
      workspace.preflight.mockResolvedValue(undefined);
      const environments = support.createService(support.createProvider());
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      if (state === "reclaimed") {
        seedAttachedPlacementEnvironment(support.testState.stateDb, {
          environmentId: "old-environment",
          sessionId: REQUEST.sessionId,
          ownerEpoch: 1,
        });
        const active = seedActivePlacement(placements, {
          environmentId: "old-environment",
          ownerEpoch: 1,
          executionMode: "remote-exec",
        });
        const draining = placements.startDrain({
          sessionId: REQUEST.sessionId,
          environmentId: "old-environment",
          ownerEpoch: 1,
          expectedGeneration: active.generation,
        });
        placements.startReconcile({
          sessionId: REQUEST.sessionId,
          environmentId: "old-environment",
          ownerEpoch: 1,
          expectedGeneration: draining.generation,
        });
        const current = placements.get(REQUEST.sessionId)!;
        placements.transition({
          sessionId: REQUEST.sessionId,
          from: "reconciling",
          to: "reclaimed",
          expectedGeneration: current.generation,
        });
        support.testState.stateDb.db
          .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
          .run("old-environment");
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      vi.spyOn(environments, "reconcileOnce").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const create = vi.spyOn(environments, "create");
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork: vi.fn(async () => {}),
        revokeSessionAuthority: vi.fn(),
      });
      const sweep = runtime.dispatchService.reconcileActive();
      await entered.promise;
      const dispatch = runtime.dispatchService.dispatch(REQUEST).then(
        () => "active",
        () => "cancelled",
      );
      const stopping = runtime.dispatchService.reclaim(REQUEST).then(
        (value) => value,
        (error: unknown) => error,
      );
      await setImmediate();
      release.resolve();
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
    },
  );

  it("does not cancel an ordinary local session without an in-flight dispatch", async () => {
    const environments = support.createService(support.createProvider());
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const interrupted = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope: `${support.testState.root}/sessions.sqlite`,
      identities: [REQUEST.sessionKey, REQUEST.sessionId],
      assertAllowed: () => {},
      onInterrupt: interrupted,
    });
    const runtime = createGatewayWorkerPlacementRuntime({
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      warn: vi.fn(),
      cancelSessionWork: vi.fn(async () => {}),
      revokeSessionAuthority: vi.fn(),
    });
    try {
      await expect(runtime.dispatchService.reclaim(REQUEST)).rejects.toThrow();
      expect(interrupted).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
  });

  it.each(["local", "activation", "move"] as const)(
    "releases admitted %s queued behind an interrupting lifecycle owner",
    async (phase) => {
      const actual = await vi.importActual<
        typeof import("./worker-environments/placement-dispatch.js")
      >("./worker-environments/placement-dispatch.js");
      const beforeBarrier = createDeferredCore();
      const enterBarrier = createDeferredCore();
      const queued = createDeferredCore();
      const mutationEntered = createDeferredCore();
      const interrupt = createDeferredCore();
      const releaseMutation = createDeferredCore();
      const events: string[] = [];
      let observeQueue = false;
      const target = moveDestinationMocks.resolveGatewaySessionTarget();
      moveDestinationMocks.resolveGatewaySessionTarget.mockImplementation(() => {
        if (observeQueue) {
          queued.resolve();
        }
        return target;
      });
      const pause = async <T>(run: () => Promise<T>): Promise<T> => {
        beforeBarrier.resolve();
        await enterBarrier.promise;
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
                    activate: () => {
                      events.push("phase-started");
                      return request.activate();
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
      const harness = createHarness(support.testState.stateDb, placements);
      const environments = {
        ...support.createService(support.createProvider()),
        ...harness.environments,
      };
      const runtime = createGatewayWorkerPlacementRuntime({
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        warn: vi.fn(),
        cancelSessionWork: vi.fn(async () => {}),
        revokeSessionAuthority: vi.fn(),
      });
      const initial =
        phase === "move" ? harness.placements.seedActive(2, "remote-exec") : undefined;
      const operation = (
        phase === "move" && initial?.state === "active"
          ? runtime.dispatchService.move({
              ...REQUEST,
              source: {
                generation: initial.generation,
                environmentId: initial.environmentId,
                ownerEpoch: initial.activeOwnerEpoch,
              },
              target: { kind: "gateway" },
            })
          : runtime.dispatchService.dispatch(REQUEST)
      ).catch((error: unknown) => error);
      await Promise.race([
        beforeBarrier.promise,
        operation.then(() => {
          throw new Error("Placement operation ended before its lifecycle barrier");
        }),
      ]);
      const identity = {
        scope: target.storePath,
        identities: [REQUEST.sessionKey, REQUEST.sessionId],
      };
      // A task kill acquires this mutation outside the admitted operation's ALS,
      // then drains admissions while its own lifecycle mutation remains active.
      const mutation = runExclusiveSessionLifecycleMutation({
        ...identity,
        prepare: async () => {
          mutationEntered.resolve();
          await interrupt.promise;
          const { released } = startSessionWorkAdmissionInterruption(identity);
          void released.then(() => events.push("admission-released"));
          await Promise.race([released, releaseMutation.promise]);
          await releaseMutation.promise;
        },
        run: async () => events.push("mutation-finished"),
      });
      try {
        await mutationEntered.promise;
        observeQueue = true;
        enterBarrier.resolve();
        await queued.promise;
        interrupt.resolve();
        await support.waitForFast(() => expect(events).toEqual(["admission-released"]));
        expect(harness.log).not.toContain("placement:active");
      } finally {
        enterBarrier.resolve();
        interrupt.resolve();
        releaseMutation.resolve();
        await Promise.allSettled([operation, mutation]);
        // Flush the canceled contender: it must never execute after its predecessor releases.
        await runExclusiveSessionLifecycleMutation({ ...identity, run: async () => {} });
      }
      expect(events).toEqual(["admission-released", "mutation-finished"]);
    },
  );

  async function createInterruptedProvision() {
    const provision = vi.fn(async () => {
      throw new Error("provider reply lost after allocation");
    });
    const destroy = vi.fn(async () => {});
    const environments = support.createService(
      support.createProvider({
        provision,
        destroy,
        resolveAllocation: async () => ({ leaseId: "lease-retained", sharedHost: false }),
      }),
    );
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const requested = placements.startDispatch(REQUEST);
    const key = "session-dispatch:" + REQUEST.sessionId + ":" + requested.generation;
    const intent = deriveEnvironmentIntent(key);
    placements.transition({
      sessionId: REQUEST.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: intent.environmentId },
    });
    await expect(
      environments.create("development", key, undefined, REQUEST.executionMode),
    ).rejects.toMatchObject({ code: "provider_failure" });
    const runtime = createGatewayWorkerPlacementRuntime({
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      warn: vi.fn(),
      cancelSessionWork: vi.fn(async (request) => {
        request.assertCurrent();
        request.onCancellationStarted?.();
      }),
      revokeSessionAuthority: vi.fn(),
    });
    const uninstall = installWorkerPlacementReconcileGuard({
      placements,
      environments,
      dispatch: runtime.dispatchService,
      isStopping: () => false,
    });
    return { provision, destroy, environments, placements, intent, runtime, uninstall };
  }

  it.each(["targeted", "sweep"] as const)(
    "retains interrupted provisioning without replay during %s recovery and permits explicit Stop",
    async (mode) => {
      const fixture = await createInterruptedProvision();
      const { environments, placements, intent, provision, destroy, runtime, uninstall } = fixture;
      try {
        for (let pass = 0; pass < 2; pass += 1) {
          await (mode === "targeted"
            ? environments.reconcileEnvironment(intent.environmentId)
            : environments.reconcileOnce());
        }
        expect(provision).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
        expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
        expect(placements.get(REQUEST.sessionId)?.state).toBe("provisioning");
        const retained = support.testState.store.get(intent.environmentId);
        expect(retained).toMatchObject({ state: "provisioning", destroyRequestedAtMs: null });
        expect(retained?.lastError).toContain("retry with fresh authority");
        expect(retained?.lastError).toContain("provider reply lost after allocation");
        await expect(runtime.dispatchService.reclaim(REQUEST)).resolves.toMatchObject({
          state: "local",
        });
        expect(provision).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
        expect(support.testState.store.get(intent.environmentId)).toMatchObject({
          state: "destroyed",
          leaseId: "lease-retained",
        });
      } finally {
        await uninstall();
      }
    },
  );

  it("continues an already durable destroy obligation without source-less provisioning", async () => {
    const { environments, intent, provision, destroy, uninstall } =
      await createInterruptedProvision();
    try {
      support.testState.store.requestDestroy({
        environmentId: intent.environmentId,
        state: "provisioning",
      });
      await environments.reconcileEnvironment(intent.environmentId);
      await environments.reconcileEnvironment(intent.environmentId);
      expect(provision).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-retained",
      });
    } finally {
      await uninstall();
    }
  });
});
