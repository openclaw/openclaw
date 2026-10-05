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

  beforeEach(() => {
    root = tempDirs.make("openclaw-terminal-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
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

  async function pendingResult(identity = SESSION) {
    const active = store.get(identity.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const claim = await store.claimTurn({
      ...identity,
      owner: placementTurnOwner(active),
      claimId: `claim-${identity.sessionId}`,
      runId: `run-${identity.sessionId}`,
    });
    await store.markWorkspaceResultPending(claim);
    const pending = (await store.listPendingWorkspaceResultsAsync()).find(
      (result) => result.sessionId === identity.sessionId,
    );
    if (!pending) {
      throw new Error("expected pending workspace result");
    }
    return { active, claim, pending };
  }

  it("records a clean terminal timestamp when reclaiming an accepted result", async () => {
    const active = await advanceToActive();
    const { claim } = await pendingResult();
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

  it("records a clean terminal timestamp for an idle destroyed-worker reclaim", async () => {
    const active = await advanceToActive();
    const draining = await store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = await store.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });

    expect(
      await store.transition({
        sessionId: active.sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation,
      }),
    ).toMatchObject({
      state: "reclaimed",
      generation: active.generation + 3,
      turnClaim: null,
      terminalReason: null,
      terminalAtMs: 1_000,
    });
  });

  it("atomically fails a pending result and preserves its bounded reason across restart", async () => {
    await advanceToActive();
    const { claim, pending } = await pendingResult();
    const closedClaims: WorkerSessionTurnClaim[] = [];
    const unregister = store.registerTurnClaimClosedHandler((closedClaim) => {
      closedClaims.push(closedClaim);
    });
    nowMs = 2_000;
    const disappearance = `cloud worker disappeared: ${"provider-detail ".repeat(100)}`;

    const failed = await store.failWorkspaceResultAndReleaseTurn(pending, new Error(disappearance));
    expect(failed).toMatchObject({
      state: "failed",
      generation: claim.placementGeneration + 3,
      turnClaim: null,
      terminalAtMs: 2_000,
    });
    expect(failed.terminalReason).toHaveLength(1_024);
    expect(failed.terminalReason).toMatch(/^cloud worker disappeared: provider-detail/u);
    expect(failed.recoveryError).toBe(failed.terminalReason);
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(closedClaims).toEqual([claim]);
    unregister();

    await closeStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const reopened = store.get(SESSION.sessionId);
    expect(reopened).toMatchObject({ state: "failed", terminalAtMs: 2_000 });
    expect(reopened?.terminalReason).toBe(failed.terminalReason);
  });

  it("atomically abandons an offline remote-exec result while preserving its exact active owner", async () => {
    await advanceToActive(SESSION, "paired-device-environment", "remote-exec");
    const { active, claim } = await pendingResult();
    const closedClaims: WorkerSessionTurnClaim[] = [];
    const unregister = store.registerTurnClaimClosedHandler((closedClaim) => {
      closedClaims.push(closedClaim);
    });

    const preserved = await store.cancelWorkspaceResultAndReleaseTurn(claim, {
      reason: "node-disconnect",
    });

    expect(preserved).toMatchObject({
      state: "active",
      environmentId: active.environmentId,
      activeOwnerEpoch: active.activeOwnerEpoch,
      generation: active.generation,
      workspaceBaseManifestRef: active.workspaceBaseManifestRef,
      turnClaim: null,
      terminalReason: null,
    });
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(closedClaims).toEqual([claim]);

    const fresh = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "local",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "fresh-paired-device-claim",
      runId: "fresh-paired-device-run",
    });
    expect(fresh.claimId).not.toBe(claim.claimId);
    expect(fresh.placementGeneration).toBe(active.generation);
    unregister();
  });

  it.each([
    "worker-owned",
    "accepted",
    "staged",
    "journaled",
    "stale-claim",
    "other-gateway",
  ] as const)(
    "does not abandon a %s workspace result after node transport loss",
    async (resultState) => {
      const executionMode = resultState === "worker-owned" ? "worker-turn" : "remote-exec";
      await advanceToActive(SESSION, "paired-device-environment", executionMode);
      const { active, claim } = await pendingResult();
      if (resultState === "accepted") {
        await store.acceptWorkspaceResult(claim);
      } else if (resultState === "staged") {
        await store.recordStagedWorkspaceResult(
          claim,
          "refs/openclaw/worker-results/preserved-result",
        );
      } else if (resultState === "journaled") {
        const basePack = Buffer.from("pending remote workspace snapshot");
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
            baseManifestRef:
              active.workspaceBaseManifestRef ??
              (() => {
                throw new Error("fixture has no accepted base");
              })(),
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
      expect(store.get(active.sessionId)).toMatchObject({
        state: "active",
        generation: active.generation,
        turnClaim: { claimId: claim.claimId },
      });
      expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
        { sessionId: active.sessionId, claimId: claim.claimId },
      ]);
    },
  );

  it("does not fail a pending result while its session operation is running", async () => {
    await advanceToActive();
    const { claim, pending } = await pendingResult();
    const binding = claim;
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-pending-send",
        requestDigest: "digest-pending-send",
      }),
    ).toMatchObject({ kind: "execute" });

    await expect(
      store.failWorkspaceResultAndReleaseTurn(pending, new Error("worker disappeared")),
    ).rejects.toThrow("running worker session operation");
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);

    expect(
      await store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-pending-send",
        requestDigest: "digest-pending-send",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    expect(
      await store.failWorkspaceResultAndReleaseTurn(pending, new Error("worker disappeared")),
    ).toMatchObject({ state: "failed", turnClaim: null });
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("does not leak terminal diagnostics between sessions sharing an environment", async () => {
    const sharedEnvironmentId = "environment-shared";
    await advanceToActive(SESSION, sharedEnvironmentId);
    const otherIdentity = {
      sessionId: "session-placement-terminal-other",
      agentId: "main",
      sessionKey: "agent:main:placement-terminal-other",
    };
    const second = await advanceToActive(otherIdentity, sharedEnvironmentId);
    const { pending } = await pendingResult();

    const failed = await store.failWorkspaceResultAndReleaseTurn(
      pending,
      new Error("cloud worker disappeared: shared lease destroyed"),
    );

    expect(failed).toMatchObject({
      terminalReason: "cloud worker disappeared: shared lease destroyed",
      terminalAtMs: 1_000,
    });
    expect(store.get(second.sessionId)).toMatchObject({
      state: "active",
      environmentId: sharedEnvironmentId,
      terminalReason: null,
      terminalAtMs: null,
    });
  });

  it("rolls back placement failure when pending-result removal aborts", async () => {
    await advanceToActive();
    const { active, claim, pending } = await pendingResult();
    database.db.exec(`
      CREATE TRIGGER reject_pending_result_delete
      BEFORE DELETE ON worker_workspace_pending_results
      BEGIN
        SELECT RAISE(ABORT, 'injected pending delete failure');
      END;
    `);

    await expect(
      store.failWorkspaceResultAndReleaseTurn(pending, new Error("worker disappeared")),
    ).rejects.toThrow("injected pending delete failure");
    expect(store.get(active.sessionId)).toMatchObject({
      state: "active",
      generation: active.generation,
      turnClaim: { claimId: claim.claimId },
      terminalReason: null,
      terminalAtMs: null,
    });
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: active.sessionId, claimId: claim.claimId },
    ]);
  });
});
