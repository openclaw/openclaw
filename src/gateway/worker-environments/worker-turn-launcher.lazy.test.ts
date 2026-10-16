import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import type { executeWorkerTurn } from "./worker-turn-execution.js";

function expectCalls(count: number, ...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

describe("worker turn execution loading", () => {
  let fixture: typeof import("./worker-turn-launcher.test-support.js");

  const createProvider = (environments = fixture.unusedEnvironments()) =>
    fixture.createWorkerSessionTurnPlacementProvider({
      placements: fixture.placements,
      environments,
    });

  const sandboxRequest = () => ({
    sessionId: fixture.SESSION_ID,
    sessionKey: fixture.SESSION_KEY,
    agentId: "main",
    workspaceDir: fixture.root,
  });

  beforeEach(async () => {
    vi.resetModules();
    // The store, provider and cleanup must share the same module generation.
    fixture = await import("./worker-turn-launcher.test-support.js");
    await fixture.setupWorkerTurnLauncherTest();
  });

  afterEach(async () => {
    vi.doUnmock("./worker-turn-execution.js");
    vi.doUnmock("./workspace-result-finalize.js");
    vi.doUnmock("./placement-sandbox.js");
    vi.restoreAllMocks();
    await fixture.cleanupWorkerTurnLauncherTest();
    vi.resetModules();
  });

  it.each([
    { mode: "worker-turn", scenario: "current" },
    { mode: "remote-exec", scenario: "current" },
    { mode: "worker-turn", scenario: "revoked" },
    { mode: "remote-exec", scenario: "claim-replaced" },
    { mode: "worker-turn", scenario: "placement-drained" },
    { mode: "remote-exec", scenario: "loader-failed" },
    { mode: "worker-turn", scenario: "cancelled" },
    { mode: "remote-exec", scenario: "cancelled" },
  ] as const)(
    "retains admission and the exact claim across $mode loading: $scenario",
    async ({ mode, scenario }) => {
      await fixture.seedActivePlacement(mode);
      const claimTurn = vi.spyOn(fixture.placements, "claimTurn");
      const loadStarted = createDeferredCore();
      const releaseLoad = createDeferredCore();
      const failure = new Error(`execution load ${scenario}`);
      const cancellation = new AbortController();
      const { createAgentRunRestartAbortError } = await import("../../agents/run-termination.js");
      const restart = createAgentRunRestartAbortError();
      let revoked = false;
      let executionAssertion: (() => void) | undefined;
      const execute = vi.fn(async (params: Parameters<typeof executeWorkerTurn>[0]) => {
        executionAssertion = params.assertRunCurrent;
        const sql = observeMainThreadSql();
        try {
          params.assertRunCurrent();
          params.assertRunCurrent();
          sql.expectIdle();
        } finally {
          sql.restore();
        }
        params.onHandoff();
        params.onTerminal?.();
        await fixture.placements.releaseTurn(params.turnClaim);
        return { meta: { durationMs: 1 } };
      });
      const load = vi.fn(async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        if (scenario === "loader-failed") {
          throw failure;
        }
        return mode === "remote-exec"
          ? { executeRemoteExecTurn: execute }
          : { executeWorkerTurn: execute };
      });
      const unselected = vi.fn(() => {
        throw new Error("unselected execution loaded");
      });
      vi.doMock("./worker-turn-execution.js", mode === "worker-turn" ? load : unselected);
      vi.doMock("./workspace-result-finalize.js", mode === "remote-exec" ? load : unselected);
      const owner = await import("./worker-turn-run-owner.js");
      const createOwner = vi.spyOn(owner, "createWorkerTurnRunOwner");
      const environments = fixture.unusedEnvironments();
      const provider = createProvider(environments);
      const onAdmitted = vi.fn();
      const assertCurrent = vi.fn(() => {
        if (revoked) {
          throw failure;
        }
      });
      const runLocal = vi.fn();
      const request = fixture.workerTurnRequest("run-lazy-execution");
      const run = provider.executeTurn(
        request,
        { ...fixture.turn(request.runId), abortSignal: cancellation.signal },
        runLocal,
        onAdmitted,
        assertCurrent,
      );
      const settled = run.catch(() => {});
      try {
        await awaitGateBeforeSettlement(loadStarted.promise, settled, "execution never loaded");
        expectCalls(1, load);
        expectCalls(0, unselected, execute);
        expectCalls(mode === "worker-turn" ? 1 : 0, createOwner, onAdmitted);
        const placement = fixture.placements.get(fixture.SESSION_ID);
        if (placement?.state !== "active") {
          throw new Error("expected retained active placement");
        }
        const claimed = claimTurn.mock.results[0];
        if (claimed?.type !== "return") {
          throw new Error("expected retained admission claim");
        }
        const retained = await claimed.value;
        expect(retained.owner).toEqual({
          kind: mode === "remote-exec" ? "local" : "worker",
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        expect(fixture.placements.validateTurnClaim(retained)).toBe(true);
        let replacement: WorkerSessionTurnClaim | undefined;
        if (scenario === "claim-replaced") {
          await fixture.placements.releaseTurn(retained);
          replacement = await fixture.placements.claimTurn({
            ...request,
            claimId: "replacement-claim",
            owner: retained.owner,
          });
        } else if (scenario === "placement-drained") {
          await fixture.placements.startDrain({
            sessionId: placement.sessionId,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
            expectedGeneration: placement.generation,
          });
        }
        revoked = scenario === "revoked";
        if (scenario === "cancelled") {
          cancellation.abort(restart);
          await expect(run).rejects.toBe(restart);
          expect(fixture.placements.get(fixture.SESSION_ID)?.turnClaim).toBeNull();
        }
        releaseLoad.resolve();
        if (scenario === "current") {
          await expect(run).resolves.toEqual({ meta: { durationMs: 1 } });
          expectCalls(1, onAdmitted, execute);
          expect(execute.mock.calls[0]?.[0].turnClaim).toEqual(retained);
          if (mode === "worker-turn") {
            expect(executionAssertion).toThrow();
          }
        } else {
          if (scenario === "cancelled") {
            await expect(run).rejects.toBe(restart);
          } else if (scenario === "revoked") {
            await expect(run).rejects.toBe(failure);
          } else if (scenario === "loader-failed") {
            await expect(run).rejects.toMatchObject({ cause: failure });
          } else {
            await expect(run).rejects.toThrow("placement changed while loading turn execution");
          }
          expectCalls(mode === "worker-turn" ? 1 : 0, onAdmitted);
          expectCalls(0, execute);
        }
        expectCalls(mode === "worker-turn" ? 1 : 0, createOwner);
        expectCalls(0, runLocal, environments.startTunnel, environments.destroy);
        expect(fixture.placements.get(fixture.SESSION_ID)?.turnClaim?.claimId).toBe(
          replacement?.claimId,
        );
      } finally {
        releaseLoad.resolve();
        await settled;
      }
    },
  );

  it("keeps required-profile execution current during workspace result publication", async () => {
    await fixture.seedActivePlacement();
    const { setRuntimeConfigSnapshot } = await import("../../config/io.js");
    const publicationOwner = await import("./placement-turn-authority.js");
    const stageResult = publicationOwner.stagePlacementWorkspaceResultWorkerPublication;
    const config = {
      session: { store: fixture.sessionTarget.storePath },
      cloudWorkers: { requiredProfile: "development" },
    };
    let checkedPendingPublication = false;
    // mock-isolation: drive the launcher guard without starting real worker execution.
    vi.doMock("./worker-turn-execution.js", () => ({
      executeWorkerTurn: async (params: Parameters<typeof executeWorkerTurn>[0]) => {
        setRuntimeConfigSnapshot(config);
        using stage = vi.spyOn(publicationOwner, "stagePlacementWorkspaceResultWorkerPublication");
        stage.mockImplementationOnce((...args) => {
          const publication = stageResult(...args);
          try {
            // Exercise the launcher's effect guard while the real writer awaits its commit.
            params.assertRunCurrent();
            setRuntimeConfigSnapshot({
              ...config,
              cloudWorkers: { requiredProfile: "another-profile" },
            });
            expect(params.assertRunCurrent).toThrow("required worker profile policy");
            setRuntimeConfigSnapshot(config);
            params.assertRunCurrent();
            checkedPendingPublication = true;
            return publication;
          } catch (error) {
            publication.rollback();
            throw error;
          }
        });
        params.onHandoff();
        await fixture.placements.markWorkspaceResultPending(params.turnClaim);
        params.onTerminal();
        await fixture.placements.acceptWorkspaceResult(params.turnClaim);
        await fixture.placements.completeWorkspaceResultAndReleaseTurn(params.turnClaim);
        return { meta: { durationMs: 1 } };
      },
    }));
    const provider = createProvider({
      ...fixture.unusedEnvironments(),
      get: fixture.attachedEnvironment,
    });
    const runId = "run-required-result-publication";
    const runLocal = vi.fn();
    await expect(
      provider.executeTurn({ ...fixture.sessionTarget, runId }, fixture.turn(runId), runLocal),
    ).resolves.toEqual({ meta: { durationMs: 1 } });
    expect(checkedPendingPublication).toBe(true);
    expect(runLocal).not.toHaveBeenCalled();
  });

  it("keeps local turns outside execution loading with an active interception", async () => {
    const failure = new Error("selected execution load reached");
    const load = vi.fn(() => {
      throw failure;
    });
    vi.doMock("./worker-turn-execution.js", load);
    vi.doMock("./workspace-result-finalize.js", load);
    const provider = createProvider();
    const request = fixture.workerTurnRequest("run-local-lazy");
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    await expect(
      provider.executeTurn(request, fixture.turn(request.runId), runLocal),
    ).resolves.toEqual({ meta: { durationMs: 1 } });
    expect(runLocal).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    await fixture.seedActivePlacement();
    await expect(
      provider.executeTurn(request, fixture.turn(request.runId), runLocal),
    ).rejects.toMatchObject({ cause: failure });
    expect(load).toHaveBeenCalledOnce();
    expect(runLocal).toHaveBeenCalledOnce();
    expect(fixture.placements.get(fixture.SESSION_ID)?.turnClaim).toBeNull();
  });

  it.each(["current", "revoked"] as const)(
    "rechecks the remote-exec placement after sandbox loading: %s",
    async (scenario) => {
      await fixture.seedActivePlacement("remote-exec");
      const loadStarted = createDeferredCore();
      const releaseLoad = createDeferredCore();
      let sandboxCalls = 0;
      vi.doMock("./placement-sandbox.js", async (importOriginal) => {
        loadStarted.resolve();
        await releaseLoad.promise;
        const actual = await importOriginal<typeof import("./placement-sandbox.js")>();
        return {
          ...actual,
          createRemoteExecPlacementSandbox: (
            params: Parameters<typeof actual.createRemoteExecPlacementSandbox>[0],
          ) => {
            sandboxCalls++;
            return actual.createRemoteExecPlacementSandbox(params);
          },
        };
      });
      const environment = {
        ...fixture.attachedEnvironment(),
        nodeDeviceId: "fixture-node",
        sshEndpoint: null,
      };
      const provider = createProvider({
        ...fixture.unusedEnvironments(),
        get: vi.fn(() => environment),
      });
      const sandbox = provider.prepareSandbox(sandboxRequest());
      const settled = sandbox.catch(() => {});
      try {
        await awaitGateBeforeSettlement(loadStarted.promise, settled, "sandbox never loaded");
        expect(sandboxCalls).toBe(0);
        if (scenario === "revoked") {
          const placement = fixture.placements.get(fixture.SESSION_ID);
          if (placement?.state !== "active") {
            throw new Error("expected active sandbox placement");
          }
          await fixture.placements.startDrain({
            sessionId: placement.sessionId,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
            expectedGeneration: placement.generation,
          });
        }
        releaseLoad.resolve();
        if (scenario === "current") {
          using prepared = await sandbox;
          expect(prepared.sandbox).toMatchObject({
            backendId: "node",
            placementNodeId: "fixture-node",
          });
          expect(sandboxCalls).toBe(1);
        } else {
          await expect(sandbox).rejects.toThrow("placement authority changed");
          expect(sandboxCalls).toBe(0);
        }
      } finally {
        releaseLoad.resolve();
        await settled;
      }
    },
  );

  it("checks sandbox eligibility before loading with an active interception", async () => {
    await fixture.seedActivePlacement("remote-exec");
    const failure = new Error("sandbox load reached");
    const load = vi.fn(() => {
      throw failure;
    });
    vi.doMock("./placement-sandbox.js", load);
    const provider = createProvider();
    const request = sandboxRequest();
    using prepared = await provider.prepareSandbox({ ...request, agentId: "other" });
    expect(prepared.sandbox).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await expect(provider.prepareSandbox(request)).rejects.toMatchObject({ cause: failure });
    expect(load).toHaveBeenCalledOnce();
  });
});
