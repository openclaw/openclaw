import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  beginSessionWorkAdmission,
  closeSessionWorkAdmissions,
} from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  admittedRecovery,
  createCoordinatorTestService,
  LOCAL_PLACEMENT,
  MOVE_REQUEST,
  preparedReclaim,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

type DispatchService = WorkerPlacementDispatchService;

describe("worker placement dispatch coordinator", () => {
  it.each([
    { outcome: "resolve", timing: "before" },
    { outcome: "reject", timing: "before" },
    { outcome: "resolve", timing: "during" },
    { outcome: "reject", timing: "during" },
  ])(
    "joins recovery queued $timing lending before the claim waiter can $outcome or reservations run",
    async ({ outcome, timing }) => {
      const claimWait = createDeferredCore();
      const waiting = createDeferredCore();
      const beforeWait = createDeferredCore();
      const enterWait = createDeferredCore();
      const firstRecovery = createDeferredCore();
      const firstEntered = createDeferredCore();
      const secondRecovery = createDeferredCore();
      const secondEntered = createDeferredCore();
      const events: string[] = [];
      const waitError = new Error("claim wait canceled");
      const recover = vi.fn(async (label: string, mode?: "results-only") => {
        events.push(`${label}:${mode ?? "ordinary"}`);
        if (label === "first") {
          firstEntered.resolve();
          await firstRecovery.promise;
          throw new Error("first recovery failed");
        }
        if (label === "second") {
          secondEntered.resolve();
          await secondRecovery.promise;
        }
      });
      const environment = createDispatchEnvironmentFixtures().ready;
      const coordinated: ReturnType<typeof coordinateWorkerPlacementDispatch> =
        coordinateWorkerPlacementDispatch(
          createCoordinatorTestService({
            dispatch: async (request) => {
              if (request.sessionId === REQUEST.sessionId) {
                try {
                  beforeWait.resolve();
                  await enterWait.promise;
                  await coordinated.awaitTurnClaimRelease(request.sessionId, () => {
                    waiting.resolve();
                    return claimWait.promise;
                  });
                } finally {
                  events.push("holder-settled");
                }
              }
              return { ...ACTIVE_PLACEMENT, ...request };
            },
            reconcileActive: async (label, admit) => {
              await admit!([REQUEST.sessionId], (mode) => recover(label ?? "full", mode));
            },
            reconcile: async (_mode, admit) => {
              await admit!([REQUEST.sessionId], (mode) => recover("startup", mode));
            },
            getEnvironmentAttachedSessionIds: () => [REQUEST.sessionId],
            readEnvironmentSessionIds: async () => [REQUEST.sessionId],
            forceDestroyEnvironment: async () => {
              events.push("destroy");
              return environment;
            },
            reclaim: preparedReclaim(async () => {
              events.push("reclaim");
              return LOCAL_PLACEMENT;
            }),
            resumeProvisioning: admittedRecovery(async () => {
              events.push("provisioning");
            }),
          }),
          (_request, run) => run(),
        );
      const holder = coordinated.dispatch(REQUEST).catch((error: unknown) => error);
      await beforeWait.promise;
      if (timing === "during") {
        enterWait.resolve();
        await waiting.promise;
      }
      const first = coordinated.reconcileActive("first").catch((error: unknown) => error);
      const destroy = coordinated.forceDestroyEnvironment(environment.environmentId);
      if (timing === "before") {
        await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
        expect(events).toEqual([]);
        enterWait.resolve();
      }
      await firstEntered.promise;
      const second = coordinated.reconcileActive("second");
      const reclaim = coordinated.reclaim(REQUEST);
      const provisioning = coordinated.resumeProvisioning(
        { ...PROVISIONING_PLACEMENT, ...REQUEST },
        async () => {},
      );
      let late: Promise<void> | undefined;
      try {
        await coordinated.reconcileActive();
        await coordinated.reconcile("startup");
        expect(events).toEqual(["first:results-only"]);
        if (outcome === "resolve") {
          claimWait.resolve();
        } else {
          claimWait.reject(waitError);
        }
        // This independent owner completes after the settled wait closes its lending window.
        await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
        late = coordinated.reconcileActive("late");
        expect(events).toEqual(["first:results-only"]);
        firstRecovery.resolve();
        await secondEntered.promise;
        expect(events).toEqual(["first:results-only", "second:results-only"]);
      } finally {
        enterWait.resolve();
        claimWait.resolve();
        firstRecovery.resolve();
        secondRecovery.resolve();
        await Promise.allSettled([holder, first, second, destroy, reclaim, provisioning, late]);
      }
      expect(await first).toMatchObject({ message: "first recovery failed" });
      expect(await holder).toMatchObject(
        outcome === "reject" ? { message: waitError.message } : { state: "active" },
      );
      expect(events).toEqual([
        "first:results-only",
        "second:results-only",
        "holder-settled",
        "destroy",
        "reclaim",
        "provisioning",
        "late:ordinary",
      ]);
    },
  );

  it("lends only to a single matching session during the wait without superseding setup", async () => {
    const beforeWait = createDeferredCore();
    const enterWait = createDeferredCore();
    const waiting = createDeferredCore();
    const releaseWait = createDeferredCore();
    const otherEntered = createDeferredCore();
    const releaseOther = createDeferredCore();
    const recover = vi.fn(async (_label: string, _mode?: "results-only") => {});
    const coordinated: ReturnType<typeof coordinateWorkerPlacementDispatch> =
      coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch: async (request, report) => {
            const placement = { ...ACTIVE_PLACEMENT, ...request };
            report?.(placement);
            if (request.sessionId === "other") {
              otherEntered.resolve();
              await releaseOther.promise;
            } else if (request.sessionId === REQUEST.sessionId) {
              beforeWait.resolve();
              await enterWait.promise;
              await coordinated.awaitTurnClaimRelease(request.sessionId, () => {
                waiting.resolve();
                return releaseWait.promise;
              });
            }
            return placement;
          },
          reconcileActive: async (label, admit) => {
            const sessions =
              label === "other"
                ? ["other"]
                : label === "multi"
                  ? [REQUEST.sessionId, "other"]
                  : [REQUEST.sessionId];
            await admit!(sessions, (mode) => recover(label!, mode));
          },
        }),
        (_request, run) => run(),
      );
    const holder = coordinated.dispatch(REQUEST);
    await beforeWait.promise;
    const setup = coordinated.waitForInitialPlacement(ACTIVE_PLACEMENT);
    const early = coordinated.reconcileActive("early");
    const other = coordinated.dispatch({ ...REQUEST, sessionId: "other" });
    await otherEntered.promise;
    enterWait.resolve();
    await waiting.promise;
    const otherRecovery = coordinated.reconcileActive("other");
    const multi = coordinated.reconcileActive("multi");
    try {
      await coordinated.reconcileActive("lent");
      expect(recover.mock.calls).toEqual([
        ["early", "results-only"],
        ["lent", "results-only"],
      ]);
    } finally {
      enterWait.resolve();
      releaseWait.resolve();
      releaseOther.resolve();
      await Promise.allSettled([holder, setup, early, other, otherRecovery, multi]);
    }
    await expect(setup).resolves.toMatchObject({ state: "active" });
    expect(recover.mock.calls).toHaveLength(4);
    expect(recover.mock.calls).toEqual(
      expect.arrayContaining([
        ["lent", "results-only"],
        ["early", "results-only"],
        ["other", undefined],
        ["multi", undefined],
      ]),
    );
  });

  it.each(["dispatch", "move"] as const)(
    "rejects admission-cancelled %s after its same-session predecessor settles",
    async (kind) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const controller = new AbortController();
      const dispatch = vi.fn(async () => ACTIVE_PLACEMENT);
      const move = vi.fn(async () => LOCAL_PLACEMENT);
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch,
          move,
          reconcileActive: async (_environmentId, admit) => {
            await admit!([REQUEST.sessionId], async () => {
              entered.resolve();
              await release.promise;
            });
          },
        }),
        (_request, run) => run(controller.signal),
      );
      const blocking = coordinated.reconcileActive("worker-active");
      await entered.promise;
      const queued =
        kind === "dispatch" ? coordinated.dispatch(REQUEST) : coordinated.move(MOVE_REQUEST);
      const result = queued.catch((error: unknown) => error);
      controller.abort(new DOMException("Stop queued work", "AbortError"));
      release.resolve();
      await blocking;
      expect(await result).toMatchObject({ name: "AbortError" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
    },
  );

  it("cancels a queued dispatch without releasing its same-session predecessor", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const dispatch = vi.fn(async () => ACTIVE_PLACEMENT);
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch,
        move: async () => {
          entered.resolve();
          await release.promise;
          return LOCAL_PLACEMENT;
        },
      }),
      (_request, run, _authorize, signal) => run(signal),
    );
    const moving = coordinated.move(MOVE_REQUEST);
    await entered.promise;
    const cancelled = coordinated.dispatch(REQUEST, undefined, undefined, controller.signal);
    controller.abort(new DOMException("Stop queued work", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const later = coordinated.dispatch(REQUEST);
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    expect(dispatch).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([moving, later]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("retains both a dispatch and a queued Move until their exact operations settle", async () => {
    const dispatchEntered = createDeferredCore();
    const dispatchRelease = createDeferredCore();
    const moveAdmission = createDeferredCore();
    let admissions = 0;
    let stopped = false;
    const service = {
      dispatch: async () => {
        dispatchEntered.resolve();
        await dispatchRelease.promise;
        return { state: "active" };
      },
      move: async () => ({ state: "local" }),
      reclaim: async (
        ...[_request, _authorize, _beforeDrain, serialize, pending]: Parameters<
          DispatchService["reclaim"]
        >
      ) => {
        expect(pending?.isCurrent()).toBe(true);
        await pending!.settled;
        return await serialize!(async () => ({ state: "reclaimed" }) as never);
      },
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, async (_request, run) => {
      if (++admissions === 2) {
        await moveAdmission.promise;
      }
      return await run();
    });
    const dispatch = coordinated.dispatch(REQUEST);
    await dispatchEntered.promise;
    const moving = coordinated.move(MOVE_REQUEST);
    const stop = coordinated.reclaim(REQUEST).then(() => {
      stopped = true;
    });
    dispatchRelease.resolve();
    try {
      await dispatch;
      await setImmediatePromise();
      expect(stopped).toBe(false);
    } finally {
      moveAdmission.resolve();
      await Promise.all([moving, stop]);
    }
    expect(stopped).toBe(true);
  });

  it("admits a genuinely later dispatch only after the earlier Stop releases its admission closure", async () => {
    const stopping = createDeferredCore();
    const finishStop = createDeferredCore();
    const scope = "/tmp/openclaw-coordinator-predecessor-admission.sqlite";
    const identities = [REQUEST.sessionKey, REQUEST.sessionId];
    const dispatch = vi.fn(async () => ({ state: "active" }));
    const service = {
      dispatch,
      reclaim: async (
        ...[_request, _authorize, _beforeDrain, serialize]: Parameters<DispatchService["reclaim"]>
      ) => {
        const release = closeSessionWorkAdmissions({
          scope,
          identities,
          reason: new Error("older Stop"),
        });
        try {
          stopping.resolve();
          await finishStop.promise;
          return await serialize!(async () => ({ state: "reclaimed" }) as never);
        } finally {
          release();
        }
      },
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, async (_request, run) => {
      const controller = new AbortController();
      const admission = await beginSessionWorkAdmission({
        scope,
        identities,
        assertAllowed: () => {},
        onInterrupt: (reason) => controller.abort(reason),
      });
      try {
        return await admission.run(() => run(controller.signal));
      } finally {
        admission.release();
      }
    });
    const previous = coordinated.reclaim(REQUEST);
    await stopping.promise;
    const later = coordinated.dispatch(REQUEST);
    try {
      await setImmediatePromise();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      finishStop.resolve();
      await previous;
    }
    await expect(later).resolves.toMatchObject({ state: "active" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each(["dispatch", "move"] as const)(
    "does not make a later Stop a predecessor of an admission-delayed %s",
    async (kind) => {
      const admitted = createDeferredCore();
      const controller = new AbortController();
      const dispatch = vi.fn(async () => ({ state: "active" }));
      const move = vi.fn(async () => ({ state: "local" }));
      const service = {
        dispatch,
        move,
        reclaim: async (
          ...[_request, _authorize, _beforeDrain, serialize, pending]: Parameters<
            DispatchService["reclaim"]
          >
        ) => {
          expect(pending?.isCurrent()).toBe(true);
          controller.abort(new Error("Stop"));
          await pending!.settled.catch(() => undefined);
          return await serialize!(async () => ({ state: "reclaimed" }) as never);
        },
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, async (_request, run) => {
        await admitted.promise;
        return await run(controller.signal);
      });
      let operationFinished = false;
      let stopFinished = false;
      const operation =
        kind === "dispatch" ? coordinated.dispatch(REQUEST) : coordinated.move(MOVE_REQUEST);
      void operation.then(
        () => {
          operationFinished = true;
        },
        () => {
          operationFinished = true;
        },
      );
      const stopping = coordinated.reclaim(REQUEST);
      void stopping.then(() => {
        stopFinished = true;
      });
      admitted.resolve();
      for (let turn = 0; turn < 10; turn++) {
        await setImmediatePromise();
      }
      expect(operationFinished).toBe(true);
      expect(stopFinished).toBe(true);
      await stopping;
      expect(dispatch).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
    },
  );

  it.each(["dispatch", "move"] as const)(
    "later %s waits for every same-session Stop while environment bookkeeping can run",
    async (kind) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const events: string[] = [];
      let stops = 0;
      const service = {
        dispatch: vi.fn(async (request: WorkerPlacementDispatchRequest) => {
          events.push(`dispatch:${request.sessionId}`);
          return { state: "active" };
        }),
        move: vi.fn(async () => {
          events.push("move");
          return { state: "local" };
        }),
        reclaim: async (
          ...[_request, _authorize, _beforeDrain, serialize]: Parameters<DispatchService["reclaim"]>
        ) => {
          if (++stops > 1) {
            throw new Error("second Stop failed");
          }
          entered.resolve();
          await release.promise;
          await coordinated.reconcileActive();
          return await serialize!(async () => {
            events.push("stop");
            return { state: "reclaimed" } as never;
          });
        },
        reconcileActive: vi.fn(async () => {
          events.push("recovery");
        }),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const stopping = coordinated.reclaim(REQUEST);
      await entered.promise;
      await expect(coordinated.reclaim(REQUEST)).rejects.toThrow("second Stop failed");
      const later =
        kind === "move" ? coordinated.move(MOVE_REQUEST) : coordinated.dispatch(REQUEST);
      await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
      await setImmediatePromise();
      const beforeRelease = [...events];
      release.resolve();
      await Promise.all([stopping, later]);
      expect(beforeRelease).toEqual(["dispatch:unrelated"]);
      expect(events).toEqual([
        "dispatch:unrelated",
        "recovery",
        "stop",
        kind === "move" ? "move" : `dispatch:${REQUEST.sessionId}`,
      ]);
      expect(coordinated.isPlacementOperationInFlight(REQUEST.sessionId)).toBe(false);
    },
  );

  it("forwards in-process transition and authorization hooks outside request equality", async () => {
    const observer = vi.fn();
    const authorize = vi.fn();
    const placement = { state: "active" };
    const dispatch = vi.fn(async (_request, report, assertCurrent) => {
      assertCurrent?.();
      report?.(placement);
      return placement;
    });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(async () => {}),
      reconcileActive: vi.fn(async () => {}),
    } as unknown as DispatchService;

    await coordinateWorkerPlacementDispatch(service, (_request, run) => run()).dispatch(
      REQUEST,
      observer,
      authorize,
    );

    expect(dispatch).toHaveBeenCalledWith(REQUEST, expect.any(Function), authorize, undefined);
    expect(authorize).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledExactlyOnceWith(placement);
  });

  it("coalesces an identical dispatch and rejects a conflicting in-flight request", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const active = { state: "active" };
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return active;
    });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(async () => {}),
      reconcileActive: vi.fn(async () => {}),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

    const first = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    await expect(
      coordinated.dispatch({ ...REQUEST, profileId: "another-profile" }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    await expect(coordinated.dispatch({ ...REQUEST, machineClass: "beast" })).rejects.toThrow(
      `Session ${REQUEST.sessionKey} is already dispatching another request`,
    );
    await expect(coordinated.dispatch({ ...REQUEST, os: "os-a" })).rejects.toThrow(
      `Session ${REQUEST.sessionKey} is already dispatching another request`,
    );
    await expect(
      coordinated.dispatch({
        ...REQUEST,
        inheritedProfile: {
          providerId: "fake",
          profileSnapshot: { settings: { region: "parent" } },
        },
      }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    const modeConflict = expect(
      coordinated.dispatch({ ...REQUEST, executionMode: "remote-exec" }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    const devicePlacementConflict = expect(
      coordinated.dispatch({
        ...REQUEST,
        devicePlacement: { requiredNodeCommands: ["system.run"], consumesWorkerSlot: true },
      }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    const retry = coordinated.dispatch(REQUEST);
    releaseDispatch.resolve();

    await Promise.all([modeConflict, devicePlacementConflict]);
    const [firstResult, retryResult] = await Promise.all([first, retry]);
    expect(retryResult).toBe(firstResult);
    expect(dispatch).toHaveBeenCalledOnce();

    await coordinated.dispatch({ ...REQUEST, profileId: "another-profile" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: "dispatch", revokedBeforeJoining: true },
    { kind: "dispatch", revokedBeforeJoining: false },
    { kind: "move", revokedBeforeJoining: true },
    { kind: "move", revokedBeforeJoining: false },
  ] as const)(
    "rejects a joined $kind when its authority is revoked (before joining: $revokedBeforeJoining)",
    async ({ kind, revokedBeforeJoining }) => {
      const ownerStarted = createDeferredCore();
      const releaseOwner = createDeferredCore();
      const expectedResult = { state: kind === "dispatch" ? "active" : "local" };
      const operation = vi.fn(async () => {
        ownerStarted.resolve();
        await releaseOwner.promise;
        return expectedResult;
      });
      const service = {
        dispatch: kind === "dispatch" ? operation : vi.fn(),
        forceDestroyEnvironment: vi.fn(),
        move: kind === "move" ? operation : vi.fn(),
        reclaim: vi.fn(),
        reconcile: vi.fn(async () => {}),
        reconcileActive: vi.fn(async () => {}),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const invoke = (authorize?: () => void) =>
        kind === "dispatch"
          ? coordinated.dispatch(REQUEST, undefined, authorize)
          : coordinated.move(MOVE_REQUEST, undefined, authorize);
      const owner = invoke();
      await ownerStarted.promise;

      let revoked = revokedBeforeJoining;
      const observedAuthorizationStates: boolean[] = [];
      const authorize = () => {
        observedAuthorizationStates.push(revoked);
        if (revoked) {
          throw new Error("session access revoked");
        }
      };
      const joined = invoke(authorize);
      revoked = true;
      const outcomes = Promise.allSettled([owner, joined]);
      releaseOwner.resolve();

      await expect(outcomes).resolves.toEqual([
        { status: "fulfilled", value: expectedResult },
        { status: "rejected", reason: new Error("session access revoked") },
      ]);
      expect(observedAuthorizationStates).toEqual(revokedBeforeJoining ? [true] : [false, true]);
      expect(operation).toHaveBeenCalledOnce();
    },
  );

  it("joins a retry before a queued reconciliation after dispatch failure", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const dispatchError = new Error("provision failed");
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      throw dispatchError;
    });
    const reconcileActive = vi.fn(async () => {});
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(async () => {}),
      reconcileActive,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

    const first = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    const reconciliation = coordinated.reconcileActive();
    const retry = coordinated.dispatch(REQUEST);
    const outcomes = Promise.allSettled([first, retry]);
    releaseDispatch.resolve();

    expect(await outcomes).toEqual([
      { status: "rejected", reason: dispatchError },
      { status: "rejected", reason: dispatchError },
    ]);
    await reconciliation;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(reconcileActive).toHaveBeenCalledOnce();

    await expect(coordinated.dispatch({ ...REQUEST, profileId: "another-profile" })).rejects.toBe(
      dispatchError,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("serializes a move against new dispatches", async () => {
    const moveStarted = createDeferredCore();
    const releaseMove = createDeferredCore();
    const dispatch = vi.fn().mockResolvedValue({ state: "active" });
    const move = vi.fn(async () => {
      moveStarted.resolve();
      await releaseMove.promise;
      return { state: "local" };
    });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      move,
      reclaim: vi.fn(),
      reconcile: vi.fn(async () => {}),
      reconcileActive: vi.fn(async () => {}),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

    const moving = coordinated.move(MOVE_REQUEST);
    await moveStarted.promise;
    const retry = coordinated.move(MOVE_REQUEST);
    await expect(
      coordinated.move({ ...MOVE_REQUEST, target: { kind: "profile", profileId: "other" } }),
    ).rejects.toThrow(`Session ${MOVE_REQUEST.sessionKey} is already moving to another target`);
    const dispatching = coordinated.dispatch(REQUEST);
    expect(dispatch).not.toHaveBeenCalled();
    releaseMove.resolve();

    const [moveResult, retryResult] = await Promise.all([moving, retry]);
    expect(retryResult).toBe(moveResult);
    await dispatching;
    expect(move).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("waits for same-session preparation before reclaim", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return ACTIVE_PLACEMENT;
    });
    const reclaim = vi.fn(async () => ({ ...ACTIVE_PLACEMENT, state: "reclaimed" as const }));
    const service = createCoordinatorTestService({
      dispatch,
      reclaim: async (_request, _authorize, _beforeDrain, serialize, pendingOperations) => {
        await pendingOperations?.settled;
        if (!serialize) {
          throw new Error("Reclaim fixture requires session admission");
        }
        return await serialize(reclaim);
      },
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

    const dispatching = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    const reclaiming = coordinated.reclaim({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    });

    try {
      await setImmediatePromise();
      expect(reclaim).not.toHaveBeenCalled();
    } finally {
      releaseDispatch.resolve();
      await Promise.all([dispatching, reclaiming]);
    }
    expect(reclaim).toHaveBeenCalledOnce();
  });

  it("coalesces full sweeps while unrelated targeted sweeps run independently", async () => {
    const fullEntered = createDeferredCore();
    const releaseFull = createDeferredCore();
    const targets: (string | undefined)[] = [];
    const service = createCoordinatorTestService({
      reconcileActive: async (environmentId) => {
        targets.push(environmentId);
        if (environmentId === undefined) {
          fullEntered.resolve();
          await releaseFull.promise;
        }
      },
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
    const first = coordinated.reconcileActive();
    await fullEntered.promise;
    const joined = coordinated.reconcileActive();
    await Promise.all([
      coordinated.reconcileActive("worker-target"),
      coordinated.reconcileActive("worker-other"),
    ]);
    expect(targets).toEqual([undefined, "worker-target", "worker-other"]);
    releaseFull.resolve();
    await Promise.all([first, joined]);
    await coordinated.reconcileActive();
    expect(targets).toEqual([undefined, "worker-target", "worker-other", undefined]);
  });

  it.each(["full", "targeted"] as const)(
    "lets a %s environment pass join recovery while that session's dispatch settles",
    async (kind) => {
      const dispatchEntered = createDeferredCore();
      const releaseDispatch = createDeferredCore();
      const environmentEntered = createDeferredCore();
      const placement = { ...PROVISIONING_PLACEMENT, ...REQUEST };
      const recoveryCore = vi.fn(async () => {});
      let environmentPass: Promise<void> | undefined;
      const reconcileEnvironmentOnce = () =>
        (environmentPass ??= (async () => {
          environmentEntered.resolve();
          await coordinated.resumeProvisioning(placement, recoveryCore);
        })().finally(() => {
          environmentPass = undefined;
        }));
      const resumeProvisioning = vi.fn(async (_placement, core) => await core());
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch: async () => {
            dispatchEntered.resolve();
            await releaseDispatch.promise;
            return ACTIVE_PLACEMENT;
          },
          reconcile: reconcileEnvironmentOnce,
          reconcileActive: reconcileEnvironmentOnce,
          resumeProvisioning: admittedRecovery(resumeProvisioning),
        }),
        (_request, run) => run(),
      );
      const dispatch = coordinated.dispatch(REQUEST);
      await dispatchEntered.promise;
      const environment = reconcileEnvironmentOnce();
      await environmentEntered.promise;
      const sweep =
        kind === "full" ? coordinated.reconcile() : coordinated.reconcileActive("worker-active");
      expect(resumeProvisioning).not.toHaveBeenCalled();
      releaseDispatch.resolve();
      await Promise.all([dispatch, environment, sweep]);
      expect(resumeProvisioning).toHaveBeenCalledOnce();
      expect(recoveryCore).toHaveBeenCalledOnce();
    },
  );

  it.each(["fulfilled", "rejected"] as const)(
    "retains recovery admission after foreground %s until the provider settles",
    async (outcome) => {
      const providerEntered = createDeferredCore();
      const providerSettled = createDeferredCore();
      const failure = new Error("recovery cleanup failed after caller completion");
      const placement = { ...PROVISIONING_PLACEMENT, ...REQUEST };
      const released = vi.fn();
      const recovery = vi.fn(async (_placement, core) => await core());
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => ({
        ...ACTIVE_PLACEMENT,
        ...request,
      }));
      const unit = vi.fn(async () => {});
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch,
          resumeProvisioning: admittedRecovery(recovery),
          reconcile: async (_mode, admit) => {
            expect(await admit!([REQUEST.sessionId], unit)).toBe(false);
          },
        }),
        async (_request, run) => {
          try {
            return await run();
          } finally {
            released();
          }
        },
      );
      const foreground = coordinated.resumeProvisioning(placement, async (_signal, retain) => {
        retain?.(providerSettled.promise);
        providerEntered.resolve();
        if (outcome === "rejected") {
          throw failure;
        }
      });
      const result = foreground.catch((error: unknown) => error);
      await providerEntered.promise;
      expect(await result).toBe(outcome === "rejected" ? failure : undefined);
      expect(released).not.toHaveBeenCalled();
      expect(coordinated.isPlacementOperationInFlight(REQUEST.sessionId)).toBe(true);
      await coordinated.resumeProvisioning(placement, async () => {}).catch(() => undefined);
      expect(recovery).toHaveBeenCalledOnce();
      await coordinated.reconcile();
      expect(unit).not.toHaveBeenCalled();
      const later = coordinated.dispatch(REQUEST);
      await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
      expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["unrelated"]);
      providerSettled.resolve();
      await later;
      expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
        "unrelated",
        REQUEST.sessionId,
      ]);
      expect(coordinated.isPlacementOperationInFlight(REQUEST.sessionId)).toBe(false);
    },
  );

  it.each(["move", "reclaim", "destroy"] as const)(
    "keeps same-session recovery behind %s while unrelated recovery proceeds",
    async (kind) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const block = async () => {
        entered.resolve();
        await release.promise;
        return LOCAL_PLACEMENT;
      };
      const recover = vi.fn(async (_placement, core) => await core());
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          move: block,
          reclaim: preparedReclaim(block),
          readEnvironmentSessionIds: async () => [REQUEST.sessionId],
          forceDestroyEnvironment: async () => {
            await block();
            return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
          },
          resumeProvisioning: admittedRecovery(recover),
        }),
        (_request, run) => run(),
      );
      const blocking =
        kind === "move"
          ? coordinated.move(MOVE_REQUEST)
          : kind === "reclaim"
            ? coordinated.reclaim(REQUEST)
            : coordinated.forceDestroyEnvironment("worker-active");
      await entered.promise;
      const same = coordinated.resumeProvisioning(
        { ...PROVISIONING_PLACEMENT, ...REQUEST },
        async () => {},
      );
      await coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
      expect(recover.mock.calls.map(([placement]) => placement.sessionId)).toEqual([
        PROVISIONING_PLACEMENT.sessionId,
      ]);
      release.resolve();
      await Promise.all([blocking, same]);
      expect(recover.mock.calls.map(([placement]) => placement.sessionId)).toEqual([
        PROVISIONING_PLACEMENT.sessionId,
        REQUEST.sessionId,
      ]);
    },
  );
});
