import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import {
  placementTurnOwner,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement-terminal",
  agentId: "main",
  sessionKey: "agent:main:placement-terminal",
};

describe("worker placement terminal persistence", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let nowMs: number;

  function openStore() {
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  }
  beforeEach(() => {
    root = tempDirs.make("openclaw-terminal-");
    nowMs = 1_000;
    openStore();
  });

  function advanceToActive(
    identity: WorkerSessionPlacementIdentity = SESSION,
    environmentId = `environment-${identity.sessionId}`,
    executionMode: "worker-turn" | "remote-exec" = "worker-turn",
  ) {
    return advancePlacementFixtureToActive(
      store,
      database,
      { ...identity, executionMode },
      { environmentId, remoteWorkspaceDir: `/workspace/${identity.sessionId}` },
    );
  }

  async function pendingResult(placement?: Awaited<ReturnType<typeof advanceToActive>>) {
    const active = placement ?? (await advanceToActive());
    const claim = await store.claimTurn({
      ...SESSION,
      owner: placementTurnOwner(active),
      claimId: "claim",
      runId: "run",
    });
    await store.markWorkspaceResultPending(claim);
    const [pending] = await store.listPendingWorkspaceResultsAsync();
    if (!pending) {
      throw new Error("expected pending workspace result");
    }
    return { active, claim, pending };
  }

  function expectPendingClaim(claim: WorkerSessionTurnClaim, generation?: number) {
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
      ...(generation === undefined ? {} : { generation }),
    });
    return expect(store.listPendingWorkspaceResultsAsync()).resolves.toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);
  }

  function trackClosedClaims() {
    const closedClaims: WorkerSessionTurnClaim[] = [];
    const unregister = store.registerTurnClaimClosedHandler((claim) => closedClaims.push(claim));
    return { closedClaims, unregister };
  }

  function failResult(
    pending: Awaited<ReturnType<typeof pendingResult>>["pending"],
    reason = "worker disappeared",
  ) {
    return store.failWorkspaceResultAndReleaseTurn(pending, new Error(reason));
  }

  it("records a clean terminal timestamp when reclaiming an accepted result", async () => {
    const { active, claim } = await pendingResult();
    await store.startWorkspaceResultDrain(claim);
    await expect(store.completeWorkspaceResultAndReleaseTurn(claim)).rejects.toThrow(
      "workspace result was not accepted",
    );
    await store.updateWorkspaceBaseManifest({ claim, manifestRef: `sha256:${"e".repeat(64)}` });
    await store.acceptWorkspaceResult(claim);

    expect(
      await completeWorkerWorkspaceTeardown({
        placements: store,
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
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("atomically fails a draining pending result and preserves its bounded reason across restart", async () => {
    const { claim, pending } = await pendingResult();
    await store.startWorkspaceResultDrain(claim);
    const { closedClaims, unregister } = trackClosedClaims();
    nowMs = 2_000;
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
    expect(store.get(claim.sessionId)).toMatchObject(terminal);
    const updated = await store.fail({
      sessionId: claim.sessionId,
      expectedGeneration: failed.generation,
      recoveryError: "synthetic cleanup failure",
    });
    expect(updated).toMatchObject({
      terminalReason: failed.terminalReason,
      recoveryError: "synthetic cleanup failure",
    });
    await expect(
      store.fail({
        sessionId: claim.sessionId,
        expectedGeneration: claim.placementGeneration,
        recoveryError: "stale cleanup failure",
      }),
    ).rejects.toThrow("changed before failure");
    expect(store.get(claim.sessionId)?.recoveryError).toBe("synthetic cleanup failure");
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(closedClaims).toEqual([claim]);
    unregister();

    await closeStateDatabaseForTest();
    openStore();
    expect(await store.getAsync(SESSION.sessionId)).toMatchObject({
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
      store.cancelWorkspaceResultAndReleaseTurn(claim, { reason: "node-disconnect" }),
    ).resolves.toMatchObject({ ...active, turnClaim: null, terminalReason: null });
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(closedClaims).toEqual([claim]);

    const fresh = await store.claimTurn({
      ...SESSION,
      owner: { ...placementTurnOwner(active), kind: "local" },
      claimId: "fresh-paired-device-claim",
      runId: "fresh-paired-device-run",
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
        await store.recordStagedWorkspaceResult(claim, "refs/openclaw/worker-results/preserved");
      } else if (resultState === "journaled") {
        const basePack = Buffer.from("snapshot");
        await store.beginWorkspaceReconciliation(
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
          ? createWorkerSessionPlacementStore({ database, now: () => nowMs })
          : store;
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
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    const operation = { toolCallId: "call", requestDigest: "digest" };
    const started = await store.beginWorkerSessionToolOperation({
      claim,
      toolName: "sessions_send",
      ...operation,
    });
    expect(started).toMatchObject({ kind: "execute" });

    await expect(failResult(pending)).rejects.toThrow("running worker session operation");
    await expectPendingClaim(claim);

    expect(
      await store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        ...operation,
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    expect(await failResult(pending)).toMatchObject({ state: "failed", turnClaim: null });
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("does not leak terminal diagnostics between sessions sharing an environment", async () => {
    const environmentId = "environment-shared";
    const first = await advanceToActive(SESSION, environmentId);
    const second = await advanceToActive(
      {
        sessionId: "session-placement-terminal-other",
        agentId: "main",
        sessionKey: "agent:main:placement-terminal-other",
      },
      environmentId,
    );
    const { pending } = await pendingResult(first);

    const reason = "cloud worker disappeared: shared lease destroyed";
    const failed = await failResult(pending, reason);

    expect(failed).toMatchObject({
      terminalReason: reason,
      terminalAtMs: 1_000,
    });
    expect(store.get(second.sessionId)).toMatchObject({
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
        database.db
          .prepare("DELETE FROM worker_workspace_pending_results WHERE session_id = ?")
          .run(active.sessionId);
        await expect(store.completeWorkspaceResultAndReleaseTurn(claim)).rejects.toThrow(
          "workspace result",
        );
      } else {
        database.db.exec(`
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
      expect(store.get(active.sessionId)).toMatchObject(preserved);
      if (missing) {
        expect(await store.listAsync()).toMatchObject([preserved]);
        expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
      } else {
        expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
          { sessionId: active.sessionId, claimId: claim.claimId },
        ]);
      }
    },
  );
});
