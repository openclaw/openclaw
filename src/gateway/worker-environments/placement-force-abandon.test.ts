import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import {
  expectPlacement,
  makeClaimInput,
  seedReconciliationJournal,
} from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";

async function createActiveAbandonmentFixture(database: OpenClawStateDatabase) {
  const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  const { environmentId } = createDispatchEnvironmentFixtures();
  seedAttachedPlacementEnvironment(database, {
    environmentId,
    sessionId: REQUEST.sessionId,
    ownerEpoch: 2,
  });
  const active = await seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
  if (active.state !== "active") {
    throw new Error("active placement fixture was not active");
  }
  return { store, environmentId, active };
}

type AbandonmentFixture = Awaited<ReturnType<typeof createActiveAbandonmentFixture>>;

function startFixtureDrain({ store, environmentId, active }: AbandonmentFixture) {
  return store.startDrain({
    sessionId: active.sessionId,
    environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: active.generation,
  });
}

describe("forced worker environment abandonment", () => {
  let root: string;
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-force-worker-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  });

  afterEach(async () => {
    await closeStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function expectAbandoned(store: AbandonmentFixture["store"]) {
    expectPlacement(store, "failed", {
      turnClaim: null,
      recoveryError: "Worker result abandoned by forced operator teardown",
    });
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
  }

  it("drains nested operations before recording result loss and releasing the claim", async ({
    signal,
  }) => {
    const { store, environmentId, active } = await createActiveAbandonmentFixture(database);
    const claim = await store.claimTurn(makeClaimInput(active, "forced-claim", "forced-run"));
    await store.markWorkspaceResultPending(claim);
    const binding = claim;
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "forced-send",
        requestDigest: "forced-send-digest",
      }),
    ).toMatchObject({ kind: "execute" });

    const toolAdmissionClosed = createDeferred();
    const closeToolState = store.closeWorkerTurnToolState.bind(store);
    vi.spyOn(store, "closeWorkerTurnToolState").mockImplementation((closingClaim) => {
      const closing = closeToolState(closingClaim);
      toolAdmissionClosed.resolve();
      return closing;
    });

    const abandonment = forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspace: async () => ({ kind: "local" as const, path: root }),
    });

    let completed = false;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          toolAdmissionClosed.promise,
          abandonment,
          "Abandonment completed before closing tool admission",
        ),
        signal,
      );
      expect(store.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
      expectPlacement(store, "active", { turnClaim: { claimId: claim.claimId } });
    } finally {
      try {
        completed = await store.completeWorkerSessionToolOperation({
          sourceSessionId: claim.sessionId,
          sourceClaimId: claim.claimId,
          toolCallId: "forced-send",
          requestDigest: "forced-send-digest",
          resultJson: '{"status":"ok"}',
        });
      } finally {
        await abandonment;
      }
    }
    expect(completed).toBe(true);

    await expectAbandoned(store);
  });

  it("releases a pending reclaim claim when its workspace is already gone", async () => {
    const { store, environmentId, active } = await createActiveAbandonmentFixture(database);
    await startFixtureDrain({ store, environmentId, active });
    const claim = await store.claimReclaimWorkspaceResult(
      makeClaimInput(active, "reclaim-forced-missing-workspace"),
    );
    await store.recordStagedWorkspaceResult(
      claim,
      "refs/openclaw/worker-results/reclaim-forced-missing-workspace",
    );
    const resolveWorkspace = vi.fn(async () => {
      throw new Error("session-owned managed worktree is missing");
    });

    await forceAbandonWorkerEnvironment({ placements: store, environmentId, resolveWorkspace });

    await expectAbandoned(store);
    expect(resolveWorkspace).toHaveBeenCalledOnce();
  });

  it.each(["release", "environment", "epoch", "placement", "claim"] as const)(
    "handles a %s change while captured abandonment reads are pending",
    async (replacement) => {
      const { store, environmentId, active } = await createActiveAbandonmentFixture(database);
      const original = await store.claimTurn(
        makeClaimInput(active, "captured-claim", "captured-run"),
      );
      await store.authorizeWorkerTurnTools(original, ["sessions_send"]);
      const entered = createDeferred();
      const release = createDeferred();
      const readPending = store.listPendingWorkspaceResultsAsync.bind(store);
      const observer = vi
        .spyOn(store, "listPendingWorkspaceResultsAsync")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return await readPending(...args);
        });
      const abandonment = forceAbandonWorkerEnvironment({
        placements: store,
        environmentId,
        resolveWorkspace: async () => ({ kind: "local" as const, path: root }),
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          abandonment,
          "Abandonment missed the read gate",
        );
        await store.releaseTurn(original);
        if (replacement === "release") {
          release.resolve();
          await abandonment;
          expect(store.get(active.sessionId)).toMatchObject({
            state: "failed",
            turnClaim: null,
            recoveryError: "Worker result abandoned by forced operator teardown",
          });
          return;
        }
        const successorEnvironment =
          replacement === "environment" ? "replacement-environment" : environmentId;
        const successorEpoch =
          replacement === "epoch" ? active.activeOwnerEpoch + 1 : active.activeOwnerEpoch;
        if (replacement !== "claim") {
          const draining = await startFixtureDrain({ store, environmentId, active });
          const reconciling = await store.startReconcile({
            sessionId: active.sessionId,
            environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            expectedGeneration: draining.generation,
          });
          await store.fail({
            sessionId: active.sessionId,
            expectedGeneration: reconciling.generation,
            recoveryError: "replacement preparation",
          });
          seedAttachedPlacementEnvironment(database, {
            environmentId: successorEnvironment,
            sessionId: active.sessionId,
            ownerEpoch: successorEpoch,
          });
          await seedActivePlacement(store, {
            environmentId: successorEnvironment,
            ownerEpoch: successorEpoch,
          });
        }
        const successor = await store.claimTurn({
          ...REQUEST,
          claimId: "successor-claim",
          runId: "successor-run",
          owner: {
            kind: "worker",
            environmentId: successorEnvironment,
            ownerEpoch: successorEpoch,
          },
        });
        await store.markWorkspaceResultPending(successor);
        await store.authorizeWorkerTurnTools(successor, ["sessions_send"]);
        const expected = store.get(active.sessionId);
        release.resolve();
        await abandonment;
        observer.mockRestore();
        expect(store.get(active.sessionId)).toEqual(expected);
        expect(store.isWorkerTurnToolAuthorized(successor, "sessions_send")).toBe(true);
        expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
          { claimId: successor.claimId, runId: successor.runId },
        ]);
      } finally {
        release.resolve();
        await abandonment;
      }
    },
  );

  it.each([
    { phase: "drain", claimed: true },
    { phase: "drain", claimed: false },
    { phase: "reconcile", claimed: true },
    { phase: "reconcile", claimed: false },
  ] as const)(
    "rejects a replacement at the native $phase transaction (captured claim: $claimed)",
    async ({ phase, claimed }) => {
      const { store, environmentId, active } = await createActiveAbandonmentFixture(database);
      const original = claimed
        ? await store.claimTurn(makeClaimInput(active, "captured-claim", "captured-run"))
        : undefined;
      const entered = createDeferred();
      const release = createDeferred();
      const hold = async <Result>(run: () => Promise<Result>): Promise<Result> => {
        entered.resolve();
        await release.promise;
        return await run();
      };
      const drain = store.startDrain.bind(store);
      const reconcile = store.startReconcile.bind(store);
      const observer =
        phase === "drain"
          ? vi
              .spyOn(store, "startDrain")
              .mockImplementation((...args) => hold(() => drain(...args)))
          : vi
              .spyOn(store, "startReconcile")
              .mockImplementation((...args) => hold(() => reconcile(...args)));
      const abandonment = forceAbandonWorkerEnvironment({
        placements: store,
        environmentId,
        resolveWorkspace: async () => ({ kind: "local" as const, path: root }),
      });
      const result = abandonment.then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          result,
          "Abandonment missed the transition gate",
        );
        if (original) {
          await store.releaseTurn(original);
        }
        const successorIdentity = {
          ...REQUEST,
          claimId: phase === "reconcile" ? "reclaim-successor" : "successor-claim",
          runId: phase === "reconcile" ? "reclaim-successor" : "successor-run",
          owner: { kind: "worker" as const, environmentId, ownerEpoch: active.activeOwnerEpoch },
        };
        const successor =
          phase === "drain"
            ? await store.claimTurn(successorIdentity)
            : await store.claimReclaimWorkspaceResult(successorIdentity);
        if (phase === "reconcile") {
          const pending = (await store.listPendingWorkspaceResultsAsync())[0];
          if (!pending) {
            throw new Error("Successor reclaim did not reserve its workspace result");
          }
          // Result abandonment does not release the reclaim producer's exact claim.
          await store.abandonWorkspaceResult(pending);
        }
        await store.authorizeWorkerTurnTools(successor, ["sessions_send"]);
        const expected = store.get(active.sessionId);
        release.resolve();
        expect(await result).toMatchObject({ kind: "rejected", error: expect.any(Error) });
        expect(store.get(active.sessionId)).toEqual(expected);
        expect(store.isWorkerTurnToolAuthorized(successor, "sessions_send")).toBe(true);
        expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
      } finally {
        release.resolve();
        await result;
        observer.mockRestore();
      }
    },
  );

  it.each(["reconciling", "local", "reclaimed"] as const)(
    "deletes a stale journal without replaying it into the %s workspace",
    async (state) => {
      const { store, environmentId, active } = await createActiveAbandonmentFixture(database);
      await seedReconciliationJournal(store, active, `sha256:${"c".repeat(64)}`, "b");
      const draining = await startFixtureDrain({ store, environmentId, active });
      const reconciling = await store.startReconcile({
        sessionId: active.sessionId,
        environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      });
      if (state !== "reconciling") {
        await store.transition({
          sessionId: active.sessionId,
          from: "reconciling",
          to: state,
          expectedGeneration: reconciling.generation,
        });
      }
      const resolveWorkspace = vi.fn(async () => ({ kind: "local" as const, path: root }));

      await forceAbandonWorkerEnvironment({ placements: store, environmentId, resolveWorkspace });

      expect(resolveWorkspace).not.toHaveBeenCalled();
      expect(await store.listWorkspaceReconciliationOwners()).toEqual([]);
      expectPlacement(store, state === "reconciling" ? "failed" : state);
    },
  );

  it.each(["rollback", "loading"] as const)(
    "retains a current journal when %s fails",
    async (phase) => {
      const fixture = await createActiveAbandonmentFixture(database);
      const { store, environmentId, active } = fixture;
      const owner = await seedReconciliationJournal(store, active, `sha256:${"d".repeat(64)}`, "c");
      const onCleanupError = vi.fn();
      const message =
        phase === "rollback"
          ? "workspace temporarily unavailable"
          : "journal temporarily unreadable";
      const resolveWorkspace = vi.fn(async () => {
        if (phase === "rollback") {
          throw new Error(message);
        }
        return { kind: "local" as const, path: root };
      });
      if (phase === "loading") {
        vi.spyOn(store, "loadWorkspaceReconciliation").mockImplementation(async () => {
          throw new Error(message);
        });
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await forceAbandonWorkerEnvironment({
          placements: store,
          environmentId,
          resolveWorkspace,
          onCleanupError,
        });
      }
      expectPlacement(store, "failed");
      expect(await store.listWorkspaceReconciliationOwners()).toEqual([owner]);
      expect(resolveWorkspace).toHaveBeenCalledTimes(phase === "rollback" ? 2 : 0);
      expect(onCleanupError).toHaveBeenCalledWith(expect.objectContaining({ message }));
    },
  );
});
