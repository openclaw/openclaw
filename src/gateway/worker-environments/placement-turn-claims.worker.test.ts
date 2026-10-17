import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveSessionPlacementForcedTerminalSettlement,
  resolveSessionPlacementTurnSettlementAssertion,
} from "../../agents/session-placement-forced-terminal-settlement.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  releaseOpenClawStateLeaseInTransaction,
} from "../../state/openclaw-state-lease-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerSessionTurnClaim, WorkerTurnClaimInput } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  createPlacementTurnClaimFixtureOps,
  seedAttachedPlacementEnvironment,
} from "./placement-test-fixtures.js";
import { ActiveTurnClaimError } from "./placement-turn-claims.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { PERSONAL_SCOPE } from "./placement-workspace-reservation.kernel.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { executeLocalTurn } from "./worker-turn-admission.js";

let database: OpenClawStateDatabase;
let placements: WorkerSessionPlacementStore;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

function input(name: string) {
  return {
    sessionId: `placement-worker-${name}`,
    agentId: "main",
    sessionKey: `agent:main:placement-worker-${name}`,
    claimId: `claim-${name}`,
    runId: `run-${name}`,
    owner: { kind: "local" as const },
  };
}

beforeAll(async () => {
  const stateDir = tempDirs.make("openclaw-placement-turn-worker-");
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  const warm = await placements.claimTurn(input("warm"));
  await placements.releaseTurn(warm);
});

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => vi.restoreAllMocks());

async function activeInput(
  name: string,
  kind: "worker" | "local" = "worker",
): Promise<WorkerTurnClaimInput> {
  const requested = input(name);
  const active = await advancePlacementFixtureToActive(
    placements,
    database,
    { ...requested, ...(kind === "local" ? { executionMode: "remote-exec" as const } : {}) },
    { environmentId: `environment-${name}` },
  );
  return {
    ...requested,
    owner: {
      kind,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    },
  };
}

async function workerClaim(name: string) {
  return placements.claimTurn(await activeInput(name));
}

async function settleResult(claim: WorkerSessionTurnClaim) {
  await placements.acceptWorkspaceResult(claim);
  await placements.completeWorkspaceResultAndReleaseTurn(claim);
}

function interceptAdmission(
  before: (request: operationAdmission.SqliteWorkerAdmissionRequest) => void,
  once = true,
) {
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  const spy = vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission");
  const intercept: typeof createAdmission = (admit, attachment) =>
    createAdmission((request, grant) => {
      before(request);
      admit(request, grant);
    }, attachment);
  return once ? spy.mockImplementationOnce(intercept) : spy.mockImplementation(intercept);
}

function revokeAt(
  stage: "transaction" | "commit",
  message: string,
  onRevoke = () => {},
  once = true,
) {
  let revoked = false;
  interceptAdmission((request) => {
    if (request.stage === stage) {
      revoked = true;
      onRevoke();
    }
  }, once);
  return {
    assertCurrent: () => {
      if (revoked) {
        throw new Error(message);
      }
    },
  };
}

function onExit(...callbacks: Array<() => void>) {
  return { [Symbol.dispose]: () => callbacks.forEach((callback) => callback()) };
}

async function withoutHostSql(run: () => Promise<void>) {
  const queries = observeHostDataSql();
  using _ = onExit(queries.restore);
  await run();
  expect(queries.queries).toEqual([]);
}

function observeProjection(requested: ReturnType<typeof input>) {
  const snapshots: ReturnType<typeof placements.readPublishedProjection>[] = [];
  const changes: SessionRowChange[] = [];
  const stop = sessionChanges.subscribeProjection((change) => {
    if ("sessionKey" in change && change.sessionKey === requested.sessionKey) {
      changes.push(change);
      snapshots.push(placements.readPublishedProjection(change));
    }
  });
  return { snapshots, changes, stop };
}

function corruptPlacementReply(matches: (value: Record<string, unknown>) => boolean) {
  const receive = brokerReply.receiveSqliteWorkerReply;
  let corrupted = 0;
  vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
    if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
      const value: unknown = deserialize(reply.value);
      if (isRecord(value) && matches(value)) {
        corrupted += 1;
        return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
      }
    }
    return receive(slot, reply, owner);
  });
  return () => corrupted;
}

function losePlacementReply(sessionId: string, outcome: "committed" | "unknown") {
  if (outcome === "unknown") {
    vi.spyOn(operationAdmission, "observeSqliteWorkerCommittedFacts").mockImplementationOnce(
      () => {},
    );
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
      (admit, attachment) => ({
        ...createAdmission(admit, attachment),
        committed: undefined,
        settlement: { kind: "unknown" as const },
      }),
    );
  }
  return corruptPlacementReply(
    (value) => isRecord(value.placement) && value.placement.sessionId === sessionId,
  );
}

it("transitions, drains and settles terminal placement failure without caller-thread SQL", async () => {
  const identity = input("transition-boundary");
  const environmentId = "transition-boundary-environment";
  const environments = await createWorkerEnvironmentStore({ database });
  seedAttachedPlacementEnvironment(database, {
    environmentId,
    sessionId: identity.sessionId,
    ownerEpoch: 7,
  });
  const observedActivation: Array<number | null | undefined> = [];
  const stop = sessionChanges.subscribe((change) => {
    if ("all" in change && change.scope === "worker-environments") {
      observedActivation.push(environments.get(environmentId)?.lastActivatedAtMs);
    }
  });
  using _ = onExit(stop);
  await withoutHostSql(async () => {
    const active = await advancePlacementFixtureToActive(placements, database, identity, {
      environmentId,
      seedEnvironment: false,
    });
    const draining = await placements.startDrain({
      sessionId: active.sessionId,
      environmentId,
      ownerEpoch: 7,
      expectedGeneration: active.generation,
      requireUnclaimed: true,
    });
    const reconciling = await placements.startReconcile({
      sessionId: active.sessionId,
      environmentId,
      ownerEpoch: 7,
      expectedGeneration: draining.generation,
    });
    const reclaimed = await placements.transition({
      sessionId: active.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    expect(reclaimed.state).toBe("reclaimed");
    const redispatched = await placements.startDispatch(identity);
    const failed = await placements.fail({
      sessionId: active.sessionId,
      expectedGeneration: redispatched.generation,
      recoveryError: "synthetic terminal failure",
    });
    const updated = await placements.fail({
      sessionId: active.sessionId,
      expectedGeneration: failed.generation,
      recoveryError: "synthetic cleanup failure",
    });
    expect(updated.generation).toBe(failed.generation);
    expect(observedActivation).toEqual([1_000]);
  });
});

it.each(["delivered", "committed", "unknown"] as const)(
  "settles %s terminal-result failure before observers without caller-thread SQL",
  async (outcome) => {
    const name = `terminal-failure-boundary-${outcome}`;
    const { sessionId, sessionKey, agentId } = input(name);
    const claim = await workerClaim(name);
    await placements.markWorkspaceResultPending(claim);
    const [pending] = await placements.listPendingWorkspaceResultsAsync(claim.sessionId);
    const authority = await placements.prepareTurnClaimAuthority(claim);
    const changes: Array<{ sessionId: string; sessionKey: string; agentId: string }> = [];
    const stopChanges = placements.subscribeChanges((placement) => changes.push(placement));
    const closed: Array<{ claimId: string; current: boolean; pending: boolean }> = [];
    const stop = placements.registerTurnClaimClosedHandler((released) => {
      closed.push({
        claimId: released.claimId,
        current: authority.isCurrent(),
        pending: placements.validateWorkspaceResultClaim(claim),
      });
    });
    const corrupted =
      outcome === "delivered" ? undefined : losePlacementReply(claim.sessionId, outcome);
    using _ = onExit(stop, stopChanges, authority.release);
    await withoutHostSql(async () => {
      const failed = placements.failWorkspaceResultAndReleaseTurn(
        pending!,
        "synthetic terminal result failure",
      );
      if (outcome === "unknown") {
        await expect(failed).rejects.toThrow();
        expect(closed).toEqual([]);
        expect(authority.isCurrent()).toBe(false);
      } else {
        await expect(failed).resolves.toMatchObject({
          state: "failed",
          generation: claim.placementGeneration + 3,
          turnClaim: null,
        });
        expect(closed).toEqual([{ claimId: claim.claimId, current: false, pending: false }]);
      }
      if (corrupted) {
        expect(corrupted()).toBe(1);
      }
      expect(changes).toEqual([{ sessionId, sessionKey, agentId }]);
    });
    expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses a transition when caller authority ends at %s admission",
  async (stage) => {
    const requested = await placements.startDispatch(input(`transition-revoked-${stage}`));
    const authority = revokeAt(stage, "transition caller revoked");
    await expect(
      placements.transition(
        {
          sessionId: requested.sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId: "revoked-transition-environment" },
        },
        authority.assertCurrent,
      ),
    ).rejects.toThrow("transition caller revoked");
    expect(placements.get(requested.sessionId)).toMatchObject({
      state: "requested",
      generation: requested.generation,
    });
  },
);

it("checks claim-free reclaim, activity and the exact terminal turn inside drain admission", async () => {
  const previous = await workerClaim("drain-claim-currentness");
  const binding = {
    sessionId: previous.sessionId,
    environmentId: previous.owner.environmentId!,
    ownerEpoch: previous.owner.ownerEpoch!,
    expectedGeneration: previous.placementGeneration,
  };
  await expect(placements.startDrain({ ...binding, requireUnclaimed: true })).rejects.toThrow(
    "during an active turn",
  );
  await placements.releaseTurn(previous);
  const later = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
  const successor = await later.claimTurn({
    ...input("drain-claim-currentness"),
    claimId: "drain-successor",
    runId: "drain-successor-run",
    owner: previous.owner,
  });
  await expect(placements.startDrain({ ...binding, expectedTurnClaim: previous })).rejects.toThrow(
    "stale worker turn",
  );
  await expect(
    placements.startDrain({ ...binding, expectedTurnClaim: successor, expectedUpdatedAtMs: 1_000 }),
  ).rejects.toThrow("changed worker placement activity");
  expect(placements.get(previous.sessionId)).toMatchObject({
    state: "active",
    generation: previous.placementGeneration,
    turnClaim: { claimId: successor.claimId },
  });
  const drained = await placements.startDrain({
    ...binding,
    expectedTurnClaim: successor,
    expectedUpdatedAtMs: 2_000,
  });
  await placements.startReconcile({ ...binding, expectedGeneration: drained.generation });
});

it("persists monotonic ACKs and their terminal fence through the gate without host SQLite", async () => {
  const claim = await workerClaim("ack-cursors");
  const gate = createWorkerSessionPlacementGate(placements);
  const retained = await placements.prepareSessionPlacement(claim.sessionId);
  let observedCommit = false;
  const admission = probe.admission(operationAdmission, (request, grant, admit) => {
    admit(request, () => {
      if (
        request.stage === "commit" &&
        isRecord(request.facts) &&
        isRecord(request.facts.placement) &&
        request.facts.placement.sessionId === claim.sessionId
      ) {
        observedCommit = true;
        expect(retained.current()).toMatchObject({
          state: "active",
          turnClaim: { claimId: claim.claimId },
        });
      }
      return grant();
    });
  });
  {
    using _ = onExit(admission.mockRestore, () => retained.release());
    await withoutHostSql(async () => {
      await gate.updateAckCursors({ claim, transcriptSeq: 4 });
      expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
      await gate.updateAckCursors({ claim, liveSeq: 9 });
      await gate.updateAckCursors({ claim, transcriptSeq: 3, liveSeq: 8 });
      await gate.updateAckCursors({ claim, transcriptSeq: 4, liveSeq: 9 });
      expect(retained.current()).toMatchObject({
        lastTranscriptAckCursor: 4,
        lastLiveEventAckCursor: 9,
      });
    });
  }
  expect(observedCommit).toBe(true);
  expect(placements.get(claim.sessionId)).toMatchObject({
    generation: claim.placementGeneration,
    lastTranscriptAckCursor: 4,
    lastLiveEventAckCursor: 9,
  });
  expect(gate.readWorkerTurnLiveAckCursor(claim)).toBe(9);
  expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toMatchObject([
    {
      claimId: claim.claimId,
      runId: claim.runId,
      gatewayInstanceId: placements.workspaceResultInstanceId(),
    },
  ]);
  await placements.acceptWorkspaceResult(claim);
  await gate.updateAckCursors({ claim, liveSeq: 9 });
  expect(
    (await placements.listPendingWorkspaceResultsAsync(claim.sessionId))[0]?.workspaceAcceptedAtMs,
  ).toBe(1_000);
  await placements.completeWorkspaceResultAndReleaseTurn(claim);
  expect(placements.get(claim.sessionId)?.turnClaim).toBeNull();
  expect(gate.validateWorkerTurn(claim)).toBe(false);
  await expect(gate.updateAckCursors({ claim, liveSeq: 10 })).rejects.toThrow("stale worker turn");
  expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
  expect(placements.get(claim.sessionId)?.lastLiveEventAckCursor).toBe(9);
});

it("keeps the maintenance inventory usable across non-local turn bookkeeping", async () => {
  const turn = await activeInput("maintenance-bookkeeping");
  const active = placements.get(turn.sessionId)!;
  const inventory = await placements.prepareMaintenancePlacements();
  let pendingChecks = 0;
  const admission = probe.admission(operationAdmission, (request, grant, admit) => {
    admit(request, () => {
      if (request.stage === "commit") {
        inventory.assertCurrent();
        pendingChecks += 1;
      }
      return grant();
    });
  });
  using _ = onExit(admission.mockRestore, () => inventory.release());
  await withoutHostSql(async () => {
    await placements.releaseTurn(await placements.claimTurn(turn));
    const claim = await placements.claimTurn(turn);
    await placements.updateAckCursors({ claim, liveEvent: 9 });
    await placements.acceptWorkspaceResult(claim);
    await placements.completeWorkspaceResultAndReleaseTurn(claim);
    inventory.assertCurrent();
    expect(pendingChecks).toBe(6);
    expect(inventory.placements).toContainEqual({ ...active, lastLiveEventAckCursor: 9 });
    const current = await placements.prepareMaintenancePlacements();
    try {
      expect(current.placements).toContainEqual({ ...active, lastLiveEventAckCursor: 9 });
    } finally {
      current.release();
    }
  });
});

it.each(["placement", "caller"] as const)(
  "rolls back both ACK cursor and terminal fence when %s authority is revoked before commit",
  async (owner) => {
    const claim = await workerClaim(`ack-revoked-${owner}`);
    const gate = createWorkerSessionPlacementGate(placements);
    const authority = revokeAt("commit", "ACK caller revoked", () => {
      if (owner === "placement") {
        gate.fenceWorkerTurnForRecovery(claim);
      }
    });
    await expect(
      gate.updateAckCursors({
        claim,
        liveSeq: 1,
        assertCurrent: () => {
          if (owner === "caller") {
            authority.assertCurrent();
          }
        },
      }),
    ).rejects.toThrow(owner === "placement" ? "stale worker turn" : "ACK caller revoked");
    expect(placements.get(claim.sessionId)?.lastLiveEventAckCursor).toBeNull();
    expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
    await placements.releaseTurn(claim);
  },
);

it.each(["committed", "unknown"] as const)(
  "preserves %s ACK custody after losing the worker reply",
  async (outcome) => {
    const claim = await workerClaim(`ack-reply-${outcome}`);
    const corrupted = losePlacementReply(claim.sessionId, outcome);
    const ack = placements.updateAckCursors({ claim, liveEvent: 1 });
    if (outcome === "committed") {
      await expect(ack).resolves.toMatchObject({ lastLiveEventAckCursor: 1 });
    } else {
      await expect(ack).rejects.toThrow();
    }
    expect(corrupted()).toBe(1);
    if (outcome === "unknown") {
      expect(() => placements.get(claim.sessionId)).toThrow("Await getAsync");
    }
    expect((await placements.getAsync(claim.sessionId))?.lastLiveEventAckCursor).toBe(1);
    expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toMatchObject([
      { claimId: claim.claimId, gatewayInstanceId: placements.workspaceResultInstanceId() },
    ]);
    // Fixture recovery settles the retained fence; an unknown ACK cannot release it.
    await settleResult(claim);
  },
);

it.each([
  ["claim", "committed"],
  ["claim", "unknown"],
  ["release", "committed"],
  ["release", "unknown"],
] as const)(
  "publishes local %s projection facts before observers across %s settlement",
  async (operation, outcome) => {
    const requested = input(`projection-${operation}-${outcome}`);
    // The fault belongs to the claim admission, not the worker's first open admission.
    const original = await placements.claimTurn(requested);
    if (operation === "claim") {
      await placements.releaseTurn(original);
    }
    await placements.readProjection([requested.sessionId]);
    const { snapshots, changes, stop } = observeProjection(requested);
    using _ = onExit(stop);
    const corrupted = losePlacementReply(requested.sessionId, outcome);
    if (operation === "claim") {
      const claim = await placements.claimTurn(requested);
      expect(corrupted()).toBe(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.placements.get(requested.sessionId)?.turnClaim?.claimId).toBe(
        requested.claimId,
      );
      expect(
        changes.every((change) => placements.readPublishedProjection(change) === undefined),
      ).toBe(true);
      stop();
      await placements.releaseTurn(claim);
    } else {
      await expect(placements.releaseTurn(original)).resolves.toMatchObject({ turnClaim: null });
      expect(corrupted()).toBe(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.placements.get(requested.sessionId)?.turnClaim).toBeNull();
      expect(placements.get(requested.sessionId)?.turnClaim).toBeNull();
    }
  },
);

it("claims and strictly releases SQL-free local turns without replacing identity", async () => {
  await withoutHostSql(async () => {
    const requested = input("idempotent");
    const claim = await placements.claimTurn(requested);
    expect(claim).toMatchObject({
      sessionId: requested.sessionId,
      claimId: requested.claimId,
      owner: { kind: "local" },
      placementGeneration: 0,
    });
    const replay = await placements.claimTurn(requested);
    expect(replay).toEqual(claim);
    await expect(placements.claimTurn({ ...requested, agentId: "another-agent" })).rejects.toThrow(
      "placement identity changed",
    );
    await expect(
      placements.claimTurn({ ...requested, runId: "another-run" }),
    ).rejects.toBeInstanceOf(ActiveTurnClaimError);
    expect(placements.get(requested.sessionId)?.turnClaim).toMatchObject({
      claimId: requested.claimId,
      runId: requested.runId,
    });
    expect(await placements.releaseTurn(replay)).toMatchObject({
      sessionId: claim.sessionId,
      state: "local",
      turnClaim: null,
    });
    await expect(placements.releaseTurn(claim)).rejects.toThrow(
      "turn claim changed before release",
    );
    expect(placements.get(requested.sessionId)?.turnClaim).toBeNull();
  });
});

it.each(["new local", "existing local", "worker"] as const)(
  "checks live publication exclusion in the %s claim write",
  async (kind) => {
    let requested: WorkerTurnClaimInput = input(
      `publication-exclusion-${kind.replaceAll(" ", "-")}`,
    );
    if (kind === "existing local") {
      await placements.releaseTurn(await placements.claimTurn(requested));
    } else if (kind === "worker") {
      requested = await activeInput(`publication-exclusion-${kind}`);
    }
    const lease = { scope: PERSONAL_SCOPE, key: requested.sessionId, owner: "publisher" };
    runOpenClawStateWriteTransaction(
      ({ db }) => acquireOpenClawStateLeaseInTransaction(db, lease, 60_000),
      { database },
    );
    await expect(placements.claimTurn(requested)).rejects.toThrow(
      "The session workspace is being published",
    );
    expect((await placements.getAsync(requested.sessionId))?.turnClaim ?? null).toBeNull();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        releaseOpenClawStateLeaseInTransaction(db, lease);
        acquireOpenClawStateLeaseInTransaction(db, lease, 60_000, null, Date.now() - 120_000);
      },
      { database },
    );
    const claimed = await placements.claimTurn(requested);
    expect(claimed.claimId).toBe(requested.claimId);
    await placements.releaseTurn(claimed);
    runOpenClawStateWriteTransaction(
      ({ db }) => releaseOpenClawStateLeaseInTransaction(db, lease),
      { database },
    );
  },
);

it("preserves same-session FIFO and cannot conditionally release a successor", async () => {
  const first = input("fifo");
  const successor = { ...first, claimId: "claim-fifo-next", runId: "run-fifo-next" };
  const [accepted] = await Promise.all([
    placements.claimTurn(first),
    expect(placements.claimTurn(successor)).rejects.toBeInstanceOf(ActiveTurnClaimError),
  ]);
  const [, next] = await Promise.all([
    placements.releaseTurn(accepted),
    placements.claimTurn(successor),
    placements.releaseTurnIfOwned(accepted),
  ]);
  expect(placements.get(first.sessionId)?.turnClaim).toMatchObject({ claimId: successor.claimId });
  await placements.releaseTurn(next);
});

it("refuses a local claim before its effect when live authority is revoked", async () => {
  const authority = revokeAt("commit", "synthetic placement admission revoked", undefined, false);
  await expect(placements.claimTurn(input("refused"), authority.assertCurrent)).rejects.toThrow(
    "synthetic placement admission revoked",
  );
  expect(await placements.getAsync("placement-worker-refused")).toBeUndefined();
});

it.each(["claim", "staged result", "workspace manifest"] as const)(
  "returns committed %s custody after its real worker reply is corrupted",
  async (operation) => {
    const requested = input(`lost-reply-${operation.replaceAll(" ", "-")}`);
    const ref = `refs/openclaw/worker-results/${requested.claimId}`;
    let stagedClaim: Awaited<ReturnType<typeof placements.claimTurn>> | undefined;
    if (operation !== "claim") {
      stagedClaim = await placements.claimTurn(
        await activeInput(`lost-reply-${operation.replaceAll(" ", "-")}`, "local"),
      );
      await placements.markWorkspaceResultPending(stagedClaim);
    }
    const corrupted = corruptPlacementReply((value) =>
      operation === "claim"
        ? isRecord(value.claim) && value.claim.claimId === requested.claimId
        : isRecord(value.placement) && value.placement.sessionId === requested.sessionId,
    );
    if (stagedClaim) {
      if (operation === "workspace manifest") {
        const manifestRef = `sha256:${"a".repeat(64)}`;
        const accepted = await placements.updateWorkspaceBaseManifest({
          claim: stagedClaim,
          manifestRef,
        });
        expect(accepted.workspaceBaseManifestRef).toBe(manifestRef);
        expect(placements.get(requested.sessionId)?.workspaceBaseManifestRef).toBe(manifestRef);
      } else {
        await placements.recordStagedWorkspaceResult(stagedClaim, ref);
        expect(
          await placements.listPendingWorkspaceResultsAsync(requested.sessionId),
        ).toMatchObject([{ claimId: stagedClaim.claimId, stagedResultRef: ref }]);
      }
      expect(corrupted()).toBe(1);
      await settleResult(stagedClaim);
    } else {
      const claim = await placements.claimTurn(requested);
      expect(corrupted()).toBe(1);
      expect(claim).toMatchObject({ claimId: requested.claimId, runId: requested.runId });
      expect(placements.get(claim.sessionId)?.turnClaim).toMatchObject({
        claimId: requested.claimId,
      });
      await placements.releaseTurn(claim);
    }
    expect(placements.get(requested.sessionId)?.turnClaim).toBeNull();
  },
);

it("keeps a later same-byte native claim authoritative when the old release reply arrives", async () => {
  const requested = input("late-reply");
  const claim = await placements.claimTurn(requested);
  const previous = await placements.prepareTurnClaimAuthority(claim);
  const releaseCommitted = createDeferredCore();
  previous.onRevoked(() => releaseCommitted.resolve());
  const replyArrived = createDeferredCore<() => void>();
  const receive = brokerReply.receiveSqliteWorkerReply;
  let delayed = false;
  vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
    if (
      !delayed &&
      slot.current?.request.type === "execute" &&
      reply.ok &&
      !reply.transfer &&
      !reply.input
    ) {
      const value: unknown = deserialize(reply.value);
      if (
        isRecord(value) &&
        isRecord(value.placement) &&
        value.placement.sessionId === claim.sessionId
      ) {
        delayed = true;
        replyArrived.resolve(() => receive(slot, reply, owner));
        return;
      }
    }
    return receive(slot, reply, owner);
  });
  const releasing = placements.releaseTurn(claim);
  // Commit receipts and command replies arrive on separate ports.
  const [deliver] = await Promise.all([replyArrived.promise, releaseCommitted.promise]);
  let pendingDelivery: (() => void) | undefined = deliver;
  let next: Awaited<ReturnType<typeof placements.prepareTurnClaimAuthority>> | undefined;
  try {
    expect(previous.isCurrent()).toBe(false);
    const replacement = createPlacementTurnClaimFixtureOps(database).claimTurn(requested);
    next = await placements.prepareTurnClaimAuthority(replacement);
    expect(next.isCurrent()).toBe(true);
    pendingDelivery = undefined;
    deliver();
    await releasing;
    expect(previous.isCurrent()).toBe(false);
    expect(next.isCurrent()).toBe(true);
    expect(placements.get(claim.sessionId)?.turnClaim).toMatchObject({
      claimId: requested.claimId,
    });
    await placements.releaseTurn(replacement);
  } finally {
    pendingDelivery?.();
    await Promise.allSettled([releasing]);
    previous.release();
    next?.release();
  }
});

it.each(["write contention", "authority"] as const)(
  "settles failed local startup without replaying it after %s",
  async (failure) => {
    const retryable = failure === "write contention";
    const claim = input(`release-refused-${failure}`);
    const refused = new Error("release authority refused");
    const peer = retryable ? new DatabaseSync(database.path) : undefined;
    const startupError = new Error("local backend startup failed");
    const release = vi.spyOn(placements, "releaseTurnIfOwned");
    let assertSettlementCurrent: (() => void) | undefined;
    let forcedFailure: unknown;
    const runLocal = vi.fn(async () => {
      assertSettlementCurrent = resolveSessionPlacementTurnSettlementAssertion();
      let attempts = 0;
      interceptAdmission((request) => {
        if (request.stage === "commit") {
          if (!peer) {
            throw refused;
          }
          // Hold a real writer lock through the first DML attempt, after admission.
          peer.exec(++attempts === 1 ? "BEGIN IMMEDIATE" : "ROLLBACK");
        }
      }, false);
      if (!retryable) {
        try {
          await resolveSessionPlacementForcedTerminalSettlement()?.();
        } catch (error) {
          forcedFailure = error;
        }
      }
      throw startupError;
    });
    try {
      await expect(executeLocalTurn({ claim, placements, runLocal })).rejects.toBe(
        retryable ? startupError : refused,
      );
    } finally {
      peer?.close();
      vi.restoreAllMocks();
    }
    expect(runLocal).toHaveBeenCalledOnce();
    if (retryable) {
      expect(() => assertSettlementCurrent?.()).toThrow("settlement is closed");
      expect(placements.get(claim.sessionId)?.turnClaim).toBeNull();
      await expect(
        executeLocalTurn({
          claim: { ...claim, runId: "local-startup-next" },
          placements,
          runLocal: async () => "next turn completed",
        }),
      ).resolves.toBe("next turn completed");
    } else {
      expect(forcedFailure).toBe(refused);
      expect(release).toHaveBeenCalledOnce();
      const retained = release.mock.calls[0]![0];
      expect(placements.get(claim.sessionId)?.turnClaim).toMatchObject({
        claimId: retained.claimId,
      });
      // Only the fixture reauthorizes refused cleanup; production must not retry it.
      await placements.releaseTurn(retained);
    }
  },
);

it.each(["reclaim", "mutation"] as const)(
  "continues and settles %s workspace custody without caller-thread SQL",
  async (purpose) => {
    const identity = await activeInput(`result-${purpose}`, "local");
    const claimId = `reclaim-result-${purpose}`;
    const requested = {
      ...identity,
      claimId,
      runId: claimId,
    };
    await withoutHostSql(async () => {
      const claim =
        purpose === "reclaim"
          ? await placements.claimReclaimWorkspaceResult(requested)
          : await placements.claimWorkspaceMutationResult(requested);
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      await placements.markWorkspaceResultPending(claim);
      const stagedResultRef = `refs/openclaw/worker-results/${claimId}`;
      await placements.recordStagedWorkspaceResult(claim, stagedResultRef);
      placements.recordWorkspaceResultConflict(claim, { paths: ["conflict.txt"], stagedResultRef });
      expect(await placements.startWorkspaceResultDrain(claim)).toMatchObject({
        state: "draining",
        generation: claim.placementGeneration + 1,
      });
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      placements.recordWorkspaceResultConflict(claim, undefined);
      await placements.handoffWorkspaceResultRecovery(claim);
      expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toMatchObject([
        { claimId, recoveryRequestedAtMs: 1_000, workspaceAcceptedAtMs: null },
      ]);
      await placements.acceptWorkspaceResult(claim);
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      await placements.completeWorkspaceResultAndReleaseTurn(claim);
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(false);
      expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
    });
  },
);

it("rejects result acceptance when the live caller is revoked before commit", async () => {
  const claim = await workerClaim("result-accept-revoked");
  await placements.markWorkspaceResultPending(claim);
  const authority = revokeAt("commit", "result caller revoked");
  await expect(placements.acceptWorkspaceResult(claim, authority.assertCurrent)).rejects.toThrow(
    "result caller revoked",
  );
  expect(
    (await placements.listPendingWorkspaceResultsAsync(claim.sessionId))[0]?.workspaceAcceptedAtMs,
  ).toBeNull();
  expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
  await settleResult(claim);
});

it.each(["prepare", "release"] as const)(
  "keeps the successor result authorized when stale %s does not own it",
  async (operation) => {
    const name = `result-successor-${operation}`;
    const previous = await workerClaim(name);
    await placements.releaseTurn(previous);
    const next = await placements.claimTurn({
      ...input(name),
      claimId: `successor-${operation}`,
      runId: `successor-run-${operation}`,
      owner: previous.owner,
    });
    await placements.markWorkspaceResultPending(next);
    await using _ = { [Symbol.asyncDispose]: () => settleResult(next) };
    if (operation === "prepare") {
      await expect(placements.prepareWorkspaceResultClaim(previous)).rejects.toThrow(
        "workspace result authority changed",
      );
    } else {
      await placements.releaseTurnIfOwned(previous);
    }
    expect(await placements.listPendingWorkspaceResultsAsync(next.sessionId)).toMatchObject([
      { claimId: next.claimId, runId: next.runId },
    ]);
    expect(placements.validateWorkspaceResultClaim(next)).toBe(true);
  },
);
