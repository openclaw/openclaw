import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  placementTurnOwner,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementClaim, sessionIdentity } from "./placement-suite.test-support.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";

const SESSION = sessionIdentity("session-placement-terminal");

describe("worker placement terminal persistence", () => {
  const h = usePlacementStoreFixture();

  function advanceToActive(
    identity: WorkerSessionPlacementIdentity = SESSION,
    environmentId = `environment-${identity.sessionId}`,
    executionMode: "worker-turn" | "remote-exec" = "worker-turn",
  ) {
    return advancePlacementFixtureToActive(
      h.store,
      h.database,
      { ...identity, executionMode },
      { environmentId, remoteWorkspaceDir: `/workspace/${identity.sessionId}` },
    );
  }

  async function pendingResult(placement?: Awaited<ReturnType<typeof advanceToActive>>) {
    const active = placement ?? (await advanceToActive());
    const claim = await h.store.claimTurn(placementClaim(active, "pending"));
    await h.store.markWorkspaceResultPending(claim);
    const [pending] = await h.store.listPendingWorkspaceResultsAsync();
    if (!pending) {
      throw new Error("expected pending workspace result");
    }
    return { active, claim, pending };
  }

  function expectPendingClaim(claim: WorkerSessionTurnClaim, generation?: number) {
    expect(h.store.get(claim.sessionId)).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
      ...(generation === undefined ? {} : { generation }),
    });
    return expect(h.store.listPendingWorkspaceResultsAsync()).resolves.toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);
  }

  function trackClosedClaims() {
    const closedClaims: WorkerSessionTurnClaim[] = [];
    const unregister = h.store.registerTurnClaimClosedHandler((claim) => closedClaims.push(claim));
    return { closedClaims, unregister };
  }

  function failResult(
    pending: Awaited<ReturnType<typeof pendingResult>>["pending"],
    reason = "worker disappeared",
  ) {
    return h.store.failWorkspaceResultAndReleaseTurn(pending, new Error(reason));
  }

  it("records a clean terminal timestamp when reclaiming an accepted result", async () => {
    const { active, claim } = await pendingResult();
    await h.store.startWorkspaceResultDrain(claim);
    await expect(h.store.completeWorkspaceResultAndReleaseTurn(claim)).rejects.toThrow(
      "workspace result was not accepted",
    );
    await h.store.updateWorkspaceBaseManifest({ claim, manifestRef: `sha256:${"e".repeat(64)}` });
    await h.store.acceptWorkspaceResult(claim);

    expect(
      await completeWorkerWorkspaceTeardown({
        placements: h.store,
        turnClaim: claim,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      }),
    ).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      terminalReason: null,
      terminalAtMs: 1_000,
    });
    expect(await h.store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("atomically fails a draining pending result and preserves its bounded reason across restart", async () => {
    const { claim, pending } = await pendingResult();
    await h.store.startWorkspaceResultDrain(claim);
    const { closedClaims, unregister } = trackClosedClaims();
    h.nowMs = 2_000;
    const disappearance = `cloud worker disappeared: ${"provider-detail ".repeat(100)}`;

    const failed = await failResult(pending, disappearance);
    const terminal = {
      state: "failed",
      generation: claim.placementGeneration + 3,
      turnClaim: null,
      terminalAtMs: 2_000,
    };
    expect(failed).toMatchObject(terminal);
    expect(failed.terminalReason).toHaveLength(1_024);
    expect(failed.terminalReason).toMatch(/^cloud worker disappeared: provider-detail/u);
    expect(failed.recoveryError).toBe(failed.terminalReason);
    expect(h.store.get(claim.sessionId)).toMatchObject(terminal);
    const failure = {
      sessionId: claim.sessionId,
      recoveryError: "synthetic cleanup failure",
    };
    const updated = await h.store.fail({ ...failure, expectedGeneration: failed.generation });
    expect(updated).toMatchObject({ ...failure, terminalReason: failed.terminalReason });
    const staleFailure = { ...failure, recoveryError: "stale cleanup failure" };
    await expect(
      h.store.fail({ ...staleFailure, expectedGeneration: claim.placementGeneration }),
    ).rejects.toThrow("changed before failure");
    expect(h.store.get(claim.sessionId)?.recoveryError).toBe("synthetic cleanup failure");
    expect(await h.store.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(closedClaims).toEqual([claim]);
    unregister();

    await closeStateDatabaseForTest();
    h.open();
    expect(await h.store.getAsync(SESSION.sessionId)).toMatchObject({
      state: "failed",
      terminalAtMs: 2_000,
      terminalReason: failed.terminalReason,
    });
  });

  it("atomically abandons an offline remote-exec result while preserving its exact active owner", async () => {
    const { active, claim } = await pendingResult(
      await advanceToActive(SESSION, "paired-device-environment", "remote-exec"),
    );
    const { closedClaims, unregister } = trackClosedClaims();

    await expect(
      h.store.cancelWorkspaceResultAndReleaseTurn(claim, { reason: "node-disconnect" }),
    ).resolves.toMatchObject({ ...active, turnClaim: null, terminalReason: null });
    expect(await h.store.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(closedClaims).toEqual([claim]);

    const fresh = await h.store.claimTurn({
      ...placementClaim(active, "fresh-paired-device"),
      owner: { ...placementTurnOwner(active), kind: "local" },
    });
    expect(fresh.claimId).not.toBe(claim.claimId);
    expect(fresh.placementGeneration).toBe(active.generation);
    unregister();
  });

  it.each(["worker-owned", "staged", "journaled", "stale-claim", "other-gateway"] as const)(
    "does not abandon a %s workspace result after node transport loss",
    async (resultState) => {
      const executionMode = resultState === "worker-owned" ? "worker-turn" : "remote-exec";
      const { active, claim } = await pendingResult(
        await advanceToActive(SESSION, "paired-device-environment", executionMode),
      );
      if (resultState === "staged") {
        await h.store.recordStagedWorkspaceResult(claim, "refs/openclaw/worker-results/preserved");
      } else if (resultState === "journaled") {
        const basePack = Buffer.from("snapshot");
        await h.store.beginWorkspaceReconciliation(
          {
            sessionId: active.sessionId,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            placementGeneration: active.generation,
          },
          {
            version: 1,
            temporaryNonce: "a".repeat(32),
            baseManifestRef: active.workspaceBaseManifestRef,
            currentManifestRef: `sha256:${"c".repeat(64)}`,
            baseEntries: [],
            appliedEntries: [],
            baseTree: "f".repeat(40),
            basePackSha256: createHash("sha256").update(basePack).digest("hex"),
            basePack,
          },
        );
      }

      const cancellationStore =
        resultState === "other-gateway"
          ? createWorkerSessionPlacementStore({ database: h.database, now: () => h.nowMs })
          : h.store;
      const cancellationClaim =
        resultState === "stale-claim" ? { ...claim, runId: "replacement-run" } : claim;
      await expect(
        cancellationStore.cancelWorkspaceResultAndReleaseTurn(cancellationClaim, {
          reason: "node-disconnect",
        }),
      ).rejects.toThrow("workspace result owner changed before cancellation");
      await expectPendingClaim(claim, active.generation);
    },
  );

  it("does not fail a pending result while its session operation is running", async () => {
    const { claim, pending } = await pendingResult();
    const turn = h.toolTurn(claim);
    await turn.authorize();
    expect(await turn.begin()).toMatchObject({ kind: "execute" });

    await expect(failResult(pending)).rejects.toThrow("running worker session operation");
    await expectPendingClaim(claim);

    expect(await turn.complete('{"status":"ok"}')).toBe(true);
    expect(await failResult(pending)).toMatchObject({ state: "failed", turnClaim: null });
    expect(await h.store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("does not leak terminal diagnostics between sessions sharing an environment", async () => {
    const environmentId = "environment-shared";
    const first = await advanceToActive(SESSION, environmentId);
    const otherSession = sessionIdentity("other");
    const second = await advanceToActive(otherSession, environmentId);
    const { pending } = await pendingResult(first);

    const reason = "cloud worker disappeared: shared lease destroyed";
    const failed = await failResult(pending, reason);

    expect(failed).toMatchObject({
      terminalReason: reason,
      terminalAtMs: 1_000,
    });
    expect(h.store.get(second.sessionId)).toMatchObject({
      state: "active",
      environmentId,
      terminalReason: null,
      terminalAtMs: null,
    });
  });

  it.each(["missing result", "delete abort"] as const)(
    "preserves placement on settlement %s",
    async (failure) => {
      const { active, claim, pending } = await pendingResult();
      const missing = failure === "missing result";
      if (missing) {
        h.database.db
          .prepare("DELETE FROM worker_workspace_pending_results WHERE session_id = ?")
          .run(active.sessionId);
        await expect(h.store.completeWorkspaceResultAndReleaseTurn(claim)).rejects.toThrow(
          "workspace result",
        );
      } else {
        h.database.db.exec(`
      CREATE TRIGGER reject_pending_result_delete
      BEFORE DELETE ON worker_workspace_pending_results
      BEGIN
        SELECT RAISE(ABORT, 'injected pending delete failure');
      END;
    `);
      }
      await expect(failResult(pending)).rejects.toThrow(
        missing ? "workspace result changed" : "injected pending delete failure",
      );
      const preserved = {
        state: "active",
        generation: active.generation,
        turnClaim: { claimId: claim.claimId },
        terminalReason: null,
        terminalAtMs: null,
      };
      expect(h.store.get(active.sessionId)).toMatchObject(preserved);
      if (missing) {
        expect(await h.store.listAsync()).toMatchObject([preserved]);
        expect(await h.store.listPendingWorkspaceResultsAsync()).toEqual([]);
      } else {
        expect(await h.store.listPendingWorkspaceResultsAsync()).toMatchObject([
          { sessionId: active.sessionId, claimId: claim.claimId },
        ]);
      }
    },
  );
});
