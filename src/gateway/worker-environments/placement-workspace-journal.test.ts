import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile-recovery.js";
import { createWorkspaceResultJournal } from "./workspace-result-settlement.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  });
});

describe("worker placement workspace journal", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(() => {
    root = tempDirs.make("openclaw-journal-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  const prune = () => store.pruneOrphanedWorkspaceReconciliations();

  const seedJournal = async () => {
    seedAttachedPlacementEnvironment(database, {
      environmentId: "worker-1",
      sessionId: REQUEST.sessionId,
      ownerEpoch: 7,
    });
    const active = await seedActivePlacement(store, { environmentId: "worker-1", ownerEpoch: 7 });
    assert(active.state === "active", "expected active placement");
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const basePack = Buffer.from("orphaned workspace base pack");
    await store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "c".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"d".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "e".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    return { active, owner };
  };

  it.each([false, true])(
    "prunes only retired journal owners (retryable rollback: %s)",
    async (retryable) => {
      const { active, owner } = await seedJournal();
      expect(await prune()).toEqual([]);
      const draining = await store.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
      assert(draining.state === "draining", "expected draining placement");
      const reconciling = await store.startReconcile({
        sessionId: draining.sessionId,
        environmentId: draining.environmentId,
        ownerEpoch: draining.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      });
      if (retryable) {
        await store.fail({
          sessionId: reconciling.sessionId,
          expectedGeneration: reconciling.generation,
          recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
        });
      }
      expect(await prune()).toEqual(retryable ? [] : [owner]);
      expect(await store.listWorkspaceReconciliationOwners()).toEqual(retryable ? [owner] : []);
    },
  );

  it("reads, writes and accepts the durable journal without host data SQL", async () => {
    const { active, owner } = await seedJournal();
    const journal = await store.loadWorkspaceReconciliation(owner);
    assert(journal, "expected journal");
    const claim = await store.claimTurn({
      ...REQUEST,
      claimId: "journal-worker-claim",
      runId: "journal-worker-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await store.markWorkspaceResultPending(claim);
    const pendingResult = store.preparedWorkspaceResult(claim)!;
    const placement = store.preparedWorkspaceResultPlacement(claim)!;
    expect(store.preparedWorkspaceResult(claim)).toBe(pendingResult);
    expect(store.preparedWorkspaceResultPlacement(claim)).toBe(placement);
    expect(() => {
      pendingResult.claimId = "different-claim";
    }).toThrow(TypeError);
    expect(() => {
      placement.turnClaim!.claimId = "different-claim";
    }).toThrow(TypeError);
    expect(store.validateWorkspaceResultClaim(claim)).toBe(true);
    const queries = observeHostDataSql();
    try {
      expect(await store.getWorkspaceReconciliationPlacement(owner)).toMatchObject({
        sessionId: active.sessionId,
        generation: active.generation,
      });
      expect(await store.listWorkspaceReconciliationOwners()).toEqual([owner]);
      expect(await store.loadWorkspaceReconciliation(owner)).toEqual(journal);
      await store.abortWorkspaceReconciliation(owner);
      expect(await store.listWorkspaceReconciliationOwners()).toEqual([]);
      await store.beginWorkspaceReconciliation(owner, journal);
      expect(store.validateWorkspaceResultClaim(claim)).toBe(true);
      expect(await prune()).toEqual([]);
      const accepted = await store.updateWorkspaceBaseManifest({
        claim,
        manifestRef: journal.currentManifestRef,
      });
      expect(accepted.workspaceBaseManifestRef).toBe(journal.currentManifestRef);
      expect(store.preparedWorkspaceResultPlacement(claim)).not.toBe(placement);
      expect(store.preparedWorkspaceResultPlacement(claim)?.workspaceBaseManifestRef).toBe(
        journal.currentManifestRef,
      );
      expect(placement.workspaceBaseManifestRef).toBe(active.workspaceBaseManifestRef);
      expect((await store.loadWorkspaceReconciliation(owner))?.appliedManifestRef).toBe(
        journal.currentManifestRef,
      );
      await store.abortWorkspaceReconciliation(owner);
      expect(queries.queries).toEqual([]);
    } finally {
      queries.restore();
    }
  });

  it("captures streamed journal bytes and owner before asynchronous admission", async () => {
    const { owner } = await seedJournal();
    const journal = await store.loadWorkspaceReconciliation(owner);
    assert(journal, "expected journal");
    await store.abortWorkspaceReconciliation(owner);
    // Cross the broker's message boundary while retaining the journal's existing pack contract.
    journal.basePack = new Uint8Array(33 * 1024 * 1024).fill(7);
    journal.basePackSha256 = createHash("sha256").update(journal.basePack).digest("hex");
    const { basePack: _basePack, ...expectedPlan } = journal;
    const requestedOwner = { ...owner };
    const pending = store.beginWorkspaceReconciliation(requestedOwner, journal);
    requestedOwner.ownerEpoch += 1;
    journal.basePack.fill(0);
    journal.temporaryNonce = "0".repeat(32);
    await pending;
    const captured = await store.loadWorkspaceReconciliation(owner);
    expect(captured).toBeDefined();
    const { basePack, ...capturedPlan } = captured!;
    expect(capturedPlan).toEqual(expectedPlan);
    expect(basePack.byteLength).toBe(33 * 1024 * 1024);
    expect(createHash("sha256").update(basePack).digest("hex")).toBe(expectedPlan.basePackSha256);
  });

  it("refuses a journal write whose original caller is revoked at commit", async () => {
    const { owner } = await seedJournal();
    const journal = await store.loadWorkspaceReconciliation(owner);
    assert(journal, "expected journal");
    await store.abortWorkspaceReconciliation(owner);
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    let revoked = false;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            revoked = true;
          }
          admit(request, grant);
        }, attachment),
    );
    await expect(
      store.beginWorkspaceReconciliation(owner, journal, () => {
        if (revoked) {
          throw new Error("journal caller revoked");
        }
      }),
    ).rejects.toThrow("journal caller revoked");
    expect(revoked).toBe(true);
    expect(await store.loadWorkspaceReconciliation(owner)).toBeUndefined();
  });

  it.each([
    { operation: "journal", outcome: "committed" },
    { operation: "acceptance", outcome: "committed" },
    { operation: "acceptance", outcome: "unknown" },
    { operation: "acceptance", outcome: "rollback" },
  ] as const)("preserves $operation custody when settlement is $outcome", async (scenario) => {
    const { active, owner } = await seedJournal();
    const journal = await store.loadWorkspaceReconciliation(owner);
    assert(journal, "expected journal");
    const claim =
      scenario.operation === "acceptance"
        ? await store.claimTurn({
            ...REQUEST,
            claimId: "journal-acceptance-claim",
            runId: "journal-acceptance-run",
            owner: {
              kind: "worker",
              environmentId: active.environmentId,
              ownerEpoch: active.activeOwnerEpoch,
            },
          })
        : undefined;
    if (claim) {
      await store.markWorkspaceResultPending(claim);
      await store.updateWorkspaceBaseManifest({ claim, manifestRef: journal.currentManifestRef });
      expect(await store.loadWorkspaceReconciliation(owner)).toEqual({
        ...journal,
        appliedManifestRef: journal.currentManifestRef,
      });
      expect(store.preparedWorkspaceResult(claim)?.workspaceAcceptedAtMs).toBeNull();
    } else {
      await store.abortWorkspaceReconciliation(owner);
    }
    if (scenario.outcome === "unknown") {
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
        (admit, attachment) => {
          const admission = createAdmission(admit, attachment);
          return {
            ...admission,
            get committed() {
              return undefined;
            },
            get settlement() {
              return { kind: "unknown" as const };
            },
          };
        },
      );
    } else if (scenario.outcome === "rollback") {
      database.db.exec(`
        CREATE TRIGGER reject_accepted_journal_cleanup
        BEFORE DELETE ON worker_workspace_reconciliations
        BEGIN
          SELECT RAISE(ABORT, 'accepted journal cleanup refused');
        END;
      `);
    }
    const receive = brokerReply.receiveSqliteWorkerReply;
    let corrupted = 0;
    vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, broker) => {
      if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
        const value: unknown = deserialize(reply.value);
        const matches =
          isRecord(value) &&
          (claim
            ? isRecord(value.placement) && value.placement.sessionId === claim.sessionId
            : value.type === "placementJournals.begin");
        if (matches) {
          corrupted += 1;
          return receive(slot, { ...reply, value: new Uint8Array([0]) }, broker);
        }
      }
      return receive(slot, reply, broker);
    });
    if (!claim) {
      await store.beginWorkspaceReconciliation(owner, journal);
      expect(corrupted).toBe(1);
      expect(await store.loadWorkspaceReconciliation(owner)).toEqual(journal);
      return;
    }
    const assertCurrent = () => {
      if (!store.validateWorkspaceResultClaim(claim)) {
        throw new Error("workspace result authority lost");
      }
    };
    const acceptance = store.acceptWorkspaceResult(claim, assertCurrent);
    if (scenario.outcome === "unknown") {
      await expect(acceptance).rejects.toBeInstanceOf(
        AcceptedWorkspacePublicationIndeterminateError,
      );
      expect(store.validateWorkspaceResultClaim(claim)).toBe(false);
      expect(store.preparedWorkspaceResult(claim)).toBeUndefined();
      const { adapter } = createWorkspaceResultJournal({
        placement: active,
        placements: store,
        turnClaim: claim,
        assertCurrent,
      });
      expect(() => adapter.abort()).toThrow("workspace result authority lost");
      expect(() => adapter.begin(journal)).toThrow("workspace result authority lost");
      await expect(
        recoverWorkerWorkspaceReconciliation({
          root,
          journal: { ...journal, appliedManifestRef: journal.currentManifestRef },
          assertCurrent,
        }),
      ).rejects.toThrow("already applied and awaits fence acceptance");
    } else if (scenario.outcome === "rollback") {
      await expect(acceptance).rejects.toThrow("accepted journal cleanup refused");
      expect(store.validateWorkspaceResultClaim(claim)).toBe(true);
      expect(store.preparedWorkspaceResult(claim)?.workspaceAcceptedAtMs).toBeNull();
    } else {
      await expect(acceptance).resolves.toBeUndefined();
      expect(store.validateWorkspaceResultClaim(claim)).toBe(true);
      expect(store.preparedWorkspaceResult(claim)).toMatchObject({
        claimId: claim.claimId,
        runId: claim.runId,
        workspaceAcceptedAtMs: 1_000,
      });
    }
    expect(corrupted).toBe(scenario.outcome === "rollback" ? 0 : 1);
    expect(await store.loadWorkspaceReconciliation(owner)).toEqual(
      scenario.outcome === "rollback"
        ? { ...journal, appliedManifestRef: journal.currentManifestRef }
        : undefined,
    );
    expect(await store.listPendingWorkspaceResultsAsync(claim.sessionId)).toMatchObject([
      {
        claimId: claim.claimId,
        runId: claim.runId,
        gatewayInstanceId: store.workspaceResultInstanceId(),
        workspaceAcceptedAtMs: scenario.outcome === "rollback" ? null : 1_000,
      },
    ]);
    expect(store.validateTurnClaim(claim)).toBe(true);
  });
});
