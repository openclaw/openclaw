import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

// Install the shared module mocks before any source imports can load the runtime.
const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();

vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: vi.fn(async () => {}),
}));

vi.mock("../agents/model-thinking-default.js", () => ({
  resolveThinkingSelection: () => {
    throw new Error("Queue settlement must not refresh model selection");
  },
}));
vi.mock("../auto-reply/thinking.js", async () => {
  const { normalizeThinkLevel } = await import("../auto-reply/thinking.shared.js");
  return { normalizeThinkLevel };
});

vi.mock("../auto-reply/reply/queue/drain.js", () => {
  const unexpectedDrain = () => {
    throw new Error("worker barrier queue fixtures must remain pending");
  };
  return {
    clearFollowupDrainCallback: () => {},
    rememberFollowupDrainCallback: unexpectedDrain,
    kickFollowupDrainIfIdle: unexpectedDrain,
    prepareStaleFollowupDrainRetirement: unexpectedDrain,
    dropAbortedFollowups: unexpectedDrain,
    scheduleFollowupDrain: unexpectedDrain,
  };
});

import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { clearCommandLane, enqueueCommandInLane } from "../process/command-queue.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayWorkerPlacementLocalDispatchBarrier } from "./server-worker-placement-local-dispatch.js";
import {
  createGatewayWorkerPlacementMoveBarrier,
  runWorkerPlacementHandoff,
} from "./server-worker-placement-move-barrier.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";
import {
  createWorkerPlacementMoveService,
  type WorkerPlacementMoveBarrier,
} from "./worker-environments/placement-move-service.js";

function createMoveBarrierBeginFixture(sessionId: string, sessionKey: string, agentId = "main") {
  const source = { generation: 4, environmentId: "environment-source", ownerEpoch: 2 };
  return {
    intent: {
      operationId: "move:v1:test",
      sessionId,
      source,
      target: { kind: "gateway" },
      abandonSource: true,
      lastError: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    placement: {
      sessionId,
      sessionKey,
      agentId,
      executionMode: "worker-turn",
      state: "draining",
      generation: 5,
      environmentId: source.environmentId,
      activeOwnerEpoch: source.ownerEpoch,
      workspaceBaseManifestRef: "manifest-source",
      remoteWorkspaceDir: "/worker/session-source",
      workerBundleHash: "c".repeat(64),
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      turnClaim: null,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
    },
    joined: false,
  } satisfies Awaited<ReturnType<Parameters<WorkerPlacementMoveBarrier>[0]["begin"]>>;
}

describe("worker placement move destination", () => {
  it.each(
    (["dispatch", "required", "reconcile", "abandon"] as const).flatMap((action) =>
      (["current", "revoked after commit"] as const).map((authority) => ({ action, authority })),
    ),
  )(
    "$action preserves another agent's lane commands under the global key ($authority authority)",
    async ({ action, authority }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionKey = "global";
        const sessionId = "research-global";
        const agentId = "research";
        let committed = false;
        const assertAuthority = () => {
          if (committed && authority === "revoked after commit") {
            throw new Error("placement authority revoked after commit");
          }
        };
        const target = {
          agentId,
          canonicalKey: sessionKey,
          store: {},
          storeKeys: [sessionKey],
          storePath: "/tmp/openclaw-worker-placement-research.sqlite",
        };
        moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValueOnce(target);
        moveDestinationMocks.resolveSessionTarget.mockResolvedValueOnce({
          assertCurrent: assertAuthority,
          assertBindingCurrent: assertAuthority,
          config: {},
          entry: { sessionId, updatedAt: 1 },
          target,
          worktree: { id: "research-worktree", path: "/gateway/research" },
          workspace: { kind: "local", path: "/gateway/research" },
        });
        const entered = createDeferred();
        const release = createDeferred();
        const lane = resolveEmbeddedSessionLane(sessionKey);
        const blocker = enqueueCommandInLane(lane, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const queued = [
          enqueueCommandInLane(lane, async () => "main", {
            sessionTarget: { agentId: "main", sessionKey, sessionId: "main-global" },
          }),
          enqueueCommandInLane(lane, async () => "legacy-main"),
          enqueueCommandInLane(lane, async () => "research", {
            sessionTarget: { agentId, sessionKey, sessionId },
          }),
        ];
        const results = Promise.allSettled(queued);
        const effects: string[] = [];
        let releaseAdmission = () => {};
        const admission =
          action === "required"
            ? undefined
            : await beginSessionWorkAdmission({
                scope: target.storePath,
                identities: [sessionKey, sessionId],
                assertAllowed: () => {},
                onInterrupt: () => {
                  effects.push("interrupt");
                  releaseAdmission();
                },
              });
        releaseAdmission = admission?.release ?? (() => {});
        const commit = () => {
          committed = true;
          effects.push("commit");
          return createMoveBarrierBeginFixture(sessionId, sessionKey, agentId);
        };
        const options = {
          placements: {
            get: () => undefined,
            waitForTurnClaimRelease: async () => {
              effects.push("claims released");
            },
          },
          awaitTurnClaimRelease: async (_sessionId: string, wait: () => Promise<void>) => wait(),
          revokeSessionAuthority: () => {
            effects.push("revoke");
          },
        };
        try {
          if (action === "required") {
            await runWorkerPlacementHandoff(
              options,
              { sessionId, sessionKey, agentId, action: "dispatch", requiredProfile: "dedicated" },
              {
                managedWorktrees: { findLiveByOwner: async () => undefined },
                resolveCanonicalSessionEntryFromStoreKeys,
                resolveGatewaySessionStoreTargetWithStore,
              },
              async () => commit().placement,
            );
          } else if (action === "dispatch") {
            await expect(
              createGatewayWorkerPlacementLocalDispatchBarrier(options)({
                sessionId,
                sessionKey,
                agentId,
                executionMode: "remote-exec",
                authorize: assertAuthority,
                startDispatch: async () => commit().placement,
              }),
            ).rejects.toThrow("is busy with active work");
          } else {
            await createGatewayWorkerPlacementMoveBarrier({
              ...options,
              loadSessionRuntime: async () => ({
                managedWorktrees: { findLiveByOwner: async () => undefined },
                resolveCanonicalSessionEntryFromStoreKeys,
                resolveGatewaySessionStoreTargetWithStore,
              }),
            })({
              sessionId,
              sessionKey,
              agentId,
              sourceDisposition: action,
              authorize: assertAuthority,
              begin: async () => commit(),
            });
          }
          expect(effects).toEqual(
            action === "required"
              ? ["commit"]
              : action === "dispatch"
                ? []
                : [
                    "commit",
                    "revoke",
                    "interrupt",
                    ...(action === "abandon" ? [] : ["claims released"]),
                  ],
          );
          release.resolve();
          await blocker;
          expect(await results).toEqual([
            { status: "fulfilled", value: "main" },
            { status: "fulfilled", value: "legacy-main" },
            action === "required" || action === "dispatch"
              ? { status: "fulfilled", value: "research" }
              : {
                  status: "rejected",
                  reason: expect.objectContaining({ name: "CommandLaneClearedError" }),
                },
          ]);
        } finally {
          admission?.release();
          release.resolve();
          clearCommandLane(lane);
          await Promise.allSettled([blocker, results]);
        }
      });
    },
  );

  it("joins an accepted keyed store write before completing a reconciled move", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionId = "session-move-source";
      const sessionKey = "agent:main:move-source";
      const target = resolveGatewaySessionStoreTargetWithStore({ cfg: {}, key: sessionKey });
      const releaseWriter = createDeferred();
      const claimsReleased = createDeferred();
      const order: string[] = [];
      const writer = runExclusiveSessionStoreWrite(
        target.storePath,
        async () => {
          await releaseWriter.promise;
          order.push("write settled");
        },
        { identities: [sessionKey] },
      );
      const barrier = createGatewayWorkerPlacementMoveBarrier({
        placements: {
          waitForTurnClaimRelease: async () => {
            claimsReleased.resolve();
          },
        },
        awaitTurnClaimRelease: async (_sessionId, wait) => await wait(),
        loadSessionRuntime: async () => ({
          managedWorktrees: { findLiveByOwner: async () => undefined },
          resolveCanonicalSessionEntryFromStoreKeys,
          resolveGatewaySessionStoreTargetWithStore,
        }),
        revokeSessionAuthority: () => {},
      });
      vi.useFakeTimers();
      const move = barrier({
        sessionId,
        sessionKey,
        agentId: "main",
        sourceDisposition: "reconcile",
        begin: async () => createMoveBarrierBeginFixture(sessionId, sessionKey),
      }).then(() => order.push("move settled"));
      try {
        await claimsReleased.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual([]);
        releaseWriter.resolve();
        await Promise.all([writer, move]);
        expect(order).toEqual(["write settled", "move settled"]);
      } finally {
        releaseWriter.resolve();
        await Promise.allSettled([writer, move]);
        vi.useRealTimers();
      }
    });
  });

  it.each([
    { name: "persists the claimed partial", claimRunId: "worker-run", outcome: "success" },
    {
      name: "joins an existing decision without new-source validation or persistence",
      claimRunId: "worker-run",
      outcome: "joined-existing",
    },
    { name: "fails before the durable move", claimRunId: "worker-run", outcome: "persist-error" },
    {
      name: "rejects a changed source after persistence",
      claimRunId: "worker-run",
      outcome: "stale-source",
    },
    {
      name: "rejects authority revoked during persistence",
      claimRunId: "worker-run",
      outcome: "revoked-authority",
    },
    {
      name: "rejects a worker claim rotated during persistence",
      claimRunId: "worker-run",
      outcome: "rotated-claim",
    },
    { name: "does not persist an unclaimed turn", claimRunId: undefined, outcome: "success" },
  ] as const)("abandonment $name before interrupting its owner", async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionId = "session-move-source";
      const sessionKey = "agent:main:move-source";
      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg: {},
        key: sessionKey,
        agentId: "main",
        clone: false,
      });
      const identities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
      const observed: string[] = [];
      const admission = await beginSessionWorkAdmission({
        scope: target.storePath,
        identities,
        assertAllowed: () => undefined,
        onInterrupt: () => {
          observed.push("interrupt");
        },
      });
      let sourceChanged = false;
      const persistAbandonedPartial = vi.fn(async () => {
        observed.push("persist");
        if (scenario.outcome === "persist-error") {
          throw new Error("transcript append failed");
        }
        sourceChanged = scenario.outcome === "stale-source";
      });
      const revokeSessionAuthority = vi.fn(() => observed.push("revoke"));
      const barrier = createGatewayWorkerPlacementMoveBarrier({
        placements: { waitForTurnClaimRelease: vi.fn() },
        awaitTurnClaimRelease: (_sessionId, wait) => wait(),
        loadSessionRuntime: async () => ({
          managedWorktrees: { findLiveByOwner: async () => undefined },
          resolveCanonicalSessionEntryFromStoreKeys,
          resolveGatewaySessionStoreTargetWithStore,
        }),
        revokeSessionAuthority,
        persistAbandonedPartial,
      });
      const begin = vi.fn(async (prepareNew?: (runId: string) => Promise<void>) => {
        observed.push("inspect-intent");
        if (scenario.outcome === "joined-existing") {
          return { ...createMoveBarrierBeginFixture(sessionId, sessionKey), joined: true };
        }
        observed.push("validate-source");
        if (scenario.claimRunId) {
          await prepareNew?.(scenario.claimRunId);
          observed.push("validate-claim");
          if (scenario.outcome === "rotated-claim") {
            throw new Error("worker turn changed");
          }
        }
        observed.push("begin");
        if (sourceChanged) {
          throw new Error("placement source changed");
        }
        return createMoveBarrierBeginFixture(sessionId, sessionKey);
      });
      const operation = barrier({
        sessionId,
        sessionKey,
        agentId: "main",
        sourceDisposition: "abandon",
        authorize: () => {
          observed.push("authorize");
          if (scenario.outcome === "revoked-authority" && observed.includes("persist")) {
            throw new Error("session access revoked");
          }
        },
        begin,
      });
      try {
        if (scenario.outcome === "persist-error") {
          await expect(operation).rejects.toThrow("transcript append failed");
          expect(revokeSessionAuthority).not.toHaveBeenCalled();
          expect(observed).toEqual(["authorize", "inspect-intent", "validate-source", "persist"]);
        } else if (scenario.outcome === "stale-source") {
          await expect(operation).rejects.toThrow("placement source changed");
          expect(revokeSessionAuthority).not.toHaveBeenCalled();
          expect(observed).toEqual([
            "authorize",
            "inspect-intent",
            "validate-source",
            "persist",
            "authorize",
            "validate-claim",
            "begin",
          ]);
        } else if (scenario.outcome === "revoked-authority") {
          await expect(operation).rejects.toThrow("session access revoked");
          expect(revokeSessionAuthority).not.toHaveBeenCalled();
          expect(observed).toEqual([
            "authorize",
            "inspect-intent",
            "validate-source",
            "persist",
            "authorize",
          ]);
        } else if (scenario.outcome === "rotated-claim") {
          await expect(operation).rejects.toThrow("worker turn changed");
          expect(revokeSessionAuthority).not.toHaveBeenCalled();
          expect(observed).toEqual([
            "authorize",
            "inspect-intent",
            "validate-source",
            "persist",
            "authorize",
            "validate-claim",
          ]);
        } else if (scenario.outcome === "joined-existing") {
          await expect(operation).resolves.toMatchObject({
            joined: true,
            placement: { state: "draining" },
          });
          expect(observed).toEqual(["authorize", "inspect-intent", "revoke", "interrupt"]);
        } else {
          await expect(operation).resolves.toMatchObject({ placement: { state: "draining" } });
          expect(observed).toEqual([
            "authorize",
            "inspect-intent",
            "validate-source",
            ...(scenario.claimRunId ? ["persist", "authorize", "validate-claim"] : []),
            "begin",
            "revoke",
            "interrupt",
          ]);
        }
        expect(begin).toHaveBeenCalledOnce();
        if (scenario.claimRunId && scenario.outcome !== "joined-existing") {
          expect(persistAbandonedPartial).toHaveBeenCalledWith({
            sessionId,
            sessionKey,
            agentId: "main",
            runId: scenario.claimRunId,
          });
        } else {
          expect(persistAbandonedPartial).not.toHaveBeenCalled();
        }
      } finally {
        admission.release();
        await operation.catch(() => undefined);
      }
    });
  });

  it.each([
    { sourceDisposition: "abandon" as const, settlesImmediately: true },
    { sourceDisposition: "reconcile" as const, settlesImmediately: false },
  ])(
    "$sourceDisposition move interruption preserves its settlement contract",
    async ({ sourceDisposition, settlesImmediately }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        vi.useFakeTimers();
        const sessionId = "session-move-source";
        const sessionKey = "agent:main:move-source";
        const target = resolveGatewaySessionStoreTargetWithStore({
          cfg: {},
          key: sessionKey,
          agentId: "main",
          clone: false,
        });
        const identities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
        const onInterrupt = vi.fn();
        const admission = await beginSessionWorkAdmission({
          scope: target.storePath,
          identities,
          assertAllowed: () => undefined,
          onInterrupt,
        });
        const waitForTurnClaimRelease = vi.fn().mockResolvedValue(undefined);
        runtimeFactoryMocks.createDiskSpace.mockReturnValue({
          read: vi.fn(),
          version: vi.fn(() => 0),
          sweep: vi.fn().mockResolvedValue(undefined),
        });
        runtimeFactoryMocks.createDispatch.mockReturnValue({
          dispatch: vi.fn(),
          forceDestroyEnvironment: vi.fn(),
          move: vi.fn(),
          reclaim: vi.fn(),
          reconcile: vi.fn(),
          reconcileActive: vi.fn(),
        });
        const { createGatewayWorkerPlacementRuntime } =
          await import("./server-worker-placement-startup.js");
        createGatewayWorkerPlacementRuntime({
          initialPlacements: [],
          scheduler: createTestGatewayScheduler(),
          getCommittedRuntimeConfig: getRuntimeConfig,
          cancelSessionWork: vi.fn(async () => {}),
          placements: {
            workspaceResultInstanceId: () => "gateway-test",
            get: () => undefined,
            list: () => [],
            waitForTurnClaimRelease,
            retireSessionPlacement: vi.fn(),
            pruneOrphanedWorkspaceReconciliations: async () => [],
            listWorkspaceReconciliationOwners: async () => [],
            listPendingWorkspaceResultsAsync: async () => [],
          } as never,
          environments: {} as never,
          gatewayNamespace: "gateway-test",
          revokeSessionAuthority: vi.fn(),
          warn: vi.fn(),
        });
        const dispatchOptions = runtimeFactoryMocks.createDispatch.mock.calls.at(-1)?.[0] as
          | {
              runMoveBarrier: Parameters<
                typeof createWorkerPlacementMoveService
              >[0]["runMoveBarrier"];
            }
          | undefined;
        if (!dispatchOptions) {
          throw new Error("worker placement move barrier was not captured");
        }
        const begin = vi.fn(async () => createMoveBarrierBeginFixture(sessionId, sessionKey));
        const operation = dispatchOptions.runMoveBarrier({
          sessionId,
          sessionKey,
          agentId: "main",
          sourceDisposition,
          begin,
        });
        let settled = false;
        void operation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        try {
          await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
          expect(onInterrupt).toHaveBeenCalledOnce();
          expect(settled).toBe(settlesImmediately);
          expect(waitForTurnClaimRelease).not.toHaveBeenCalled();
          if (!settlesImmediately) {
            await vi.advanceTimersByTimeAsync(15_000);
            await expect(operation).rejects.toThrow("placement move interrupted");
          } else {
            await expect(operation).resolves.toMatchObject({ placement: { state: "draining" } });
          }
        } finally {
          admission.release();
          await operation.catch(() => undefined);
          vi.useRealTimers();
        }
      });
    },
  );
});
