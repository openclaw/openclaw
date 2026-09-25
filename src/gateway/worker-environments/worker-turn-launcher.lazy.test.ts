import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";

describe("worker turn execution loading", () => {
  let fixture: typeof import("./worker-turn-launcher.test-support.js");

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

  describe.each(["worker-turn", "remote-exec"] as const)("%s", (mode) => {
    it.each([
      "current",
      "revoked",
      "claim-replaced",
      "placement-drained",
      "loader-failed",
    ] as const)("retains admission and the exact claim across loading: %s", async (scenario) => {
      fixture.seedActivePlacement(mode);
      const claimTurn = vi.spyOn(fixture.placements, "claimTurn");
      const loadStarted = createDeferredCore();
      const releaseLoad = createDeferredCore();
      const failure = new Error(`execution load ${scenario}`);
      let revoked = false;
      const execute = vi.fn(
        async (params: {
          onHandoff: () => void;
          onTerminal?: () => void;
          turnClaim: WorkerSessionTurnClaim;
        }) => {
          params.onHandoff();
          params.onTerminal?.();
          fixture.placements.releaseTurn(params.turnClaim);
          return { meta: { durationMs: 1 } };
        },
      );
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
      const provider = fixture.createWorkerSessionTurnPlacementProvider({
        environments,
        placements: fixture.placements,
      });
      const onAdmitted = vi.fn();
      const assertCurrent = vi.fn(() => {
        if (revoked) {
          throw failure;
        }
      });
      const runLocal = vi.fn();
      const request = {
        sessionId: fixture.SESSION_ID,
        sessionKey: fixture.SESSION_KEY,
        agentId: "main",
        runId: "run-lazy-execution",
      };
      const run = provider.executeTurn(
        request,
        fixture.turn(request.runId),
        runLocal,
        onAdmitted,
        assertCurrent,
      );
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      try {
        expect(
          await Promise.race([
            loadStarted.promise.then(() => "loading"),
            settled.then(() => "settled"),
          ]),
        ).toBe("loading");
        expect(load).toHaveBeenCalledOnce();
        expect(unselected).not.toHaveBeenCalled();
        expect(createOwner).not.toHaveBeenCalled();
        expect(onAdmitted).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        const placement = fixture.placements.get(fixture.SESSION_ID);
        if (placement?.state !== "active") {
          throw new Error("expected retained active placement");
        }
        const claimed = claimTurn.mock.results[0];
        if (claimed?.type !== "return") {
          throw new Error("expected retained admission claim");
        }
        const retained = claimed.value;
        expect(retained.owner).toEqual({
          kind: mode === "remote-exec" ? "local" : "worker",
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        expect(fixture.placements.validateTurnClaim(retained)).toBe(true);
        let replacement: WorkerSessionTurnClaim | undefined;
        if (scenario === "claim-replaced") {
          fixture.placements.releaseTurn(retained);
          replacement = fixture.placements.claimTurn({
            ...request,
            claimId: "replacement-claim",
            owner: retained.owner,
          });
        } else if (scenario === "placement-drained") {
          fixture.placements.startDrain({
            sessionId: placement.sessionId,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
            expectedGeneration: placement.generation,
          });
        }
        revoked = scenario === "revoked";
        releaseLoad.resolve();
        if (scenario === "current") {
          await expect(run).resolves.toEqual({ meta: { durationMs: 1 } });
          expect(onAdmitted).toHaveBeenCalledOnce();
          expect(execute).toHaveBeenCalledOnce();
          expect(execute.mock.calls[0]?.[0].turnClaim).toEqual(retained);
          expect(createOwner).toHaveBeenCalledTimes(mode === "worker-turn" ? 1 : 0);
        } else {
          if (scenario === "revoked") {
            await expect(run).rejects.toBe(failure);
          } else if (scenario === "loader-failed") {
            await expect(run).rejects.toMatchObject({ cause: failure });
          } else {
            await expect(run).rejects.toThrow("placement changed while loading turn execution");
          }
          expect(createOwner).not.toHaveBeenCalled();
          expect(onAdmitted).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
        }
        expect(runLocal).not.toHaveBeenCalled();
        expect(environments.startTunnel).not.toHaveBeenCalled();
        expect(environments.destroy).not.toHaveBeenCalled();
        expect(fixture.placements.get(fixture.SESSION_ID)?.turnClaim?.claimId).toBe(
          replacement?.claimId,
        );
      } finally {
        releaseLoad.resolve();
        await settled;
      }
    });
  });

  it("keeps local turns outside execution loading with an active interception", async () => {
    const failure = new Error("selected execution load reached");
    const load = vi.fn(() => {
      throw failure;
    });
    vi.doMock("./worker-turn-execution.js", load);
    vi.doMock("./workspace-result-finalize.js", load);
    const provider = fixture.createWorkerSessionTurnPlacementProvider({
      environments: fixture.unusedEnvironments(),
      placements: fixture.placements,
    });
    const request = {
      sessionId: fixture.SESSION_ID,
      sessionKey: fixture.SESSION_KEY,
      agentId: "main",
      runId: "run-local-lazy",
    };
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    await expect(
      provider.executeTurn(request, fixture.turn(request.runId), runLocal),
    ).resolves.toEqual({ meta: { durationMs: 1 } });
    expect(runLocal).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    fixture.seedActivePlacement();
    await expect(
      provider.executeTurn(request, fixture.turn(request.runId), runLocal),
    ).rejects.toMatchObject({ cause: failure });
    expect(load).toHaveBeenCalledOnce();
    expect(runLocal).toHaveBeenCalledOnce();
    expect(fixture.placements.get(fixture.SESSION_ID)?.turnClaim).toBeNull();
  });

  it.each(["current", "revoked", "loader-failed"] as const)(
    "rechecks the remote-exec placement after sandbox loading: %s",
    async (scenario) => {
      fixture.seedActivePlacement("remote-exec");
      const loadStarted = createDeferredCore();
      const releaseLoad = createDeferredCore();
      const failure = new Error("sandbox load failed");
      let sandboxCalls = 0;
      vi.doMock("./placement-sandbox.js", async (importOriginal) => {
        loadStarted.resolve();
        await releaseLoad.promise;
        if (scenario === "loader-failed") {
          throw failure;
        }
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
      const provider = fixture.createWorkerSessionTurnPlacementProvider({
        environments: { ...fixture.unusedEnvironments(), get: vi.fn(() => environment) },
        placements: fixture.placements,
      });
      const sandbox = provider.resolveSandbox({
        sessionId: fixture.SESSION_ID,
        sessionKey: fixture.SESSION_KEY,
        agentId: "main",
        workspaceDir: fixture.root,
      });
      const settled = sandbox.then(
        () => undefined,
        () => undefined,
      );
      try {
        expect(
          await Promise.race([
            loadStarted.promise.then(() => "loading"),
            settled.then(() => "settled"),
          ]),
        ).toBe("loading");
        expect(sandboxCalls).toBe(0);
        if (scenario === "revoked") {
          const placement = fixture.placements.get(fixture.SESSION_ID);
          if (placement?.state !== "active") {
            throw new Error("expected active sandbox placement");
          }
          fixture.placements.startDrain({
            sessionId: placement.sessionId,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
            expectedGeneration: placement.generation,
          });
        }
        releaseLoad.resolve();
        if (scenario === "current") {
          await expect(sandbox).resolves.toMatchObject({
            backendId: "node",
            placementNodeId: "fixture-node",
          });
          expect(sandboxCalls).toBe(1);
        } else {
          if (scenario === "revoked") {
            await expect(sandbox).rejects.toThrow("changed while preparing its sandbox");
          } else {
            await expect(sandbox).rejects.toMatchObject({ cause: failure });
          }
          expect(sandboxCalls).toBe(0);
        }
      } finally {
        releaseLoad.resolve();
        await settled;
      }
    },
  );

  it("checks sandbox eligibility before loading with an active interception", async () => {
    fixture.seedActivePlacement("remote-exec");
    const failure = new Error("sandbox load reached");
    const load = vi.fn(() => {
      throw failure;
    });
    vi.doMock("./placement-sandbox.js", load);
    const provider = fixture.createWorkerSessionTurnPlacementProvider({
      environments: fixture.unusedEnvironments(),
      placements: fixture.placements,
    });
    const request = {
      sessionId: fixture.SESSION_ID,
      sessionKey: fixture.SESSION_KEY,
      agentId: "main",
      workspaceDir: fixture.root,
    };
    await expect(provider.resolveSandbox({ ...request, agentId: "other" })).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
    await expect(provider.resolveSandbox(request)).rejects.toMatchObject({ cause: failure });
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps the reconciliation error constructor shared with the loaded thrower", async () => {
    fixture.seedActivePlacement();
    const { WorkerWorkspaceReconciliationError } = await import("./worker-turn-failure.js");
    const { recoverWorkspaceBeforeTurn } = await import("./workspace-result-finalize.js");
    const placement = fixture.placements.get(fixture.SESSION_ID);
    if (placement?.state !== "active") {
      throw new Error("expected active recovery placement");
    }
    const claim = fixture.placements.claimTurn({
      sessionId: fixture.SESSION_ID,
      sessionKey: fixture.SESSION_KEY,
      agentId: "main",
      runId: "run-load-recovery",
      claimId: "recovery-claim",
      owner: {
        kind: "worker",
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      },
    });
    const cause = new Error("recovery rejected");
    const recovery = recoverWorkspaceBeforeTurn({
      placement,
      placements: fixture.placements,
      turnClaim: claim,
      workspace: { kind: "local", path: fixture.root },
      workspaceOperations: {
        run: async () => {
          throw cause;
        },
      },
    });
    await expect(recovery).rejects.toBeInstanceOf(WorkerWorkspaceReconciliationError);
    await expect(recovery).rejects.toMatchObject({ cause });
    fixture.placements.releaseTurn(claim);
  });
});
