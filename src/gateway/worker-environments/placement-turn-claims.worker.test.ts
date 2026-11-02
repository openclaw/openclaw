import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionPlacementTurnSettlementAssertion } from "../../agents/session-placement-forced-terminal-settlement.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
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
import type { WorkerTurnClaimInput } from "./placement-record.js";
import { placementTurnOwner } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  seedAttachedPlacementEnvironment,
} from "./placement-test-fixtures.js";
import { ActiveTurnClaimError, createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { PERSONAL_SCOPE } from "./placement-workspace-reservation.kernel.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { executeLocalTurn } from "./worker-turn-admission.js";

let database: OpenClawStateDatabase;
let placements: WorkerSessionPlacementStore;
let stateDir: string;
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
  stateDir = tempDirs.make("openclaw-placement-turn-worker-");
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  const warm = await placements.claimTurn(input("warm"));
  await placements.releaseTurn(warm);
});

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => vi.restoreAllMocks());

async function activeClaimInput(
  name: string,
  executionMode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  const requested = input(name);
  const active = await advancePlacementFixtureToActive(
    placements,
    database,
    { ...requested, executionMode },
    {
      environmentId: `environment-${name}`,
    },
  );
  return { ...requested, owner: placementTurnOwner(active) };
}

async function workerClaim(name: string) {
  return placements.claimTurn(await activeClaimInput(name));
}

const pendingResults = (claim: { sessionId: string }) =>
  placements.listPendingWorkspaceResultsAsync(claim.sessionId);
async function settleResult(claim: Awaited<ReturnType<typeof workerClaim>>) {
  await placements.acceptWorkspaceResult(claim);
  await placements.completeWorkspaceResultAndReleaseTurn(claim);
}

function observeSql() {
  const observer = observeHostDataSql();
  return { ...observer, [Symbol.dispose]: () => observer.restore() };
}

function revokeAtAdmission(stage: "transaction" | "commit", revoke = () => {}) {
  let revoked = false;
  const create = operationAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
    (admit, attachment) =>
      create((request, grant) => {
        if (request.stage === stage) {
          revoked = true;
          revoke();
        }
        admit(request, grant);
      }, attachment),
  );
  return () => revoked;
}

function corruptReply(matches: (value: Record<string, unknown>) => boolean) {
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
  }
  return corruptReply(
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
  using queries = observeSql();
  try {
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
    expect(updated).toMatchObject({
      state: "failed",
      generation: failed.generation,
      terminalReason: "synthetic terminal failure",
      recoveryError: "synthetic cleanup failure",
    });
    expect(queries.queries).toEqual([]);
    expect(observedActivation).toEqual([1_000]);
  } finally {
    stop();
  }
});

it.each(["delivered", "committed", "unknown"] as const)(
  "settles %s terminal-result failure before observers without caller-thread SQL",
  async (outcome) => {
    const name = `terminal-failure-boundary-${outcome}`;
    const requested = input(name);
    const claim = await workerClaim(name);
    await placements.markWorkspaceResultPending(claim);
    const [pending] = await pendingResults(claim);
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
    using queries = observeSql();
    try {
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
      expect(changes).toEqual([
        {
          sessionId: requested.sessionId,
          sessionKey: requested.sessionKey,
          agentId: requested.agentId,
        },
      ]);
      expect(queries.queries).toEqual([]);
    } finally {
      stop();
      stopChanges();
      authority.release();
    }
    expect(await pendingResults(claim)).toEqual([]);
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses a transition when caller authority ends at %s admission",
  async (stage) => {
    const requested = await placements.startDispatch(input(`transition-revoked-${stage}`));
    const revoked = revokeAtAdmission(stage);
    await expect(
      placements.transition(
        {
          sessionId: requested.sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId: "revoked-transition-environment" },
        },
        () => {
          if (revoked()) {
            throw new Error("transition caller revoked");
          }
        },
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
  using queries = observeSql();
  try {
    await gate.updateAckCursors({ claim, transcriptSeq: 4 });
    expect(await pendingResults(claim)).toEqual([]);
    await gate.updateAckCursors({ claim, liveSeq: 9 });
    await gate.updateAckCursors({ claim, transcriptSeq: 3, liveSeq: 8 });
    await gate.updateAckCursors({ claim, transcriptSeq: 4, liveSeq: 9 });
    expect(retained.current()).toMatchObject({
      lastTranscriptAckCursor: 4,
      lastLiveEventAckCursor: 9,
    });
    expect(queries.queries).toEqual([]);
  } finally {
    admission.mockRestore();
    retained.release();
  }
  expect(observedCommit).toBe(true);
  expect(placements.get(claim.sessionId)).toMatchObject({
    generation: claim.placementGeneration,
    lastTranscriptAckCursor: 4,
    lastLiveEventAckCursor: 9,
  });
  expect(gate.readWorkerTurnLiveAckCursor(claim)).toBe(9);
  expect(await pendingResults(claim)).toMatchObject([
    {
      claimId: claim.claimId,
      runId: claim.runId,
      gatewayInstanceId: placements.workspaceResultInstanceId(),
    },
  ]);
  await placements.acceptWorkspaceResult(claim);
  await gate.updateAckCursors({ claim, liveSeq: 9 });
  expect((await pendingResults(claim))[0]?.workspaceAcceptedAtMs).toBe(1_000);
  await placements.completeWorkspaceResultAndReleaseTurn(claim);
  expect(placements.get(claim.sessionId)?.turnClaim).toBeNull();
  expect(gate.validateWorkerTurn(claim)).toBe(false);
  await expect(gate.updateAckCursors({ claim, liveSeq: 10 })).rejects.toThrow("stale worker turn");
  expect(await pendingResults(claim)).toEqual([]);
  expect(placements.get(claim.sessionId)?.lastLiveEventAckCursor).toBe(9);
});

it("keeps the maintenance inventory usable across non-local turn bookkeeping", async () => {
  const requested = input("maintenance-bookkeeping");
  const active = await advancePlacementFixtureToActive(placements, database, requested, {
    environmentId: "maintenance-bookkeeping-environment",
  });
  const inventory = await placements.prepareMaintenancePlacements();
  const turn = {
    ...requested,
    owner: placementTurnOwner(active),
  };
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
  using queries = observeSql();
  try {
    await placements.releaseTurn(await placements.claimTurn(turn));
    const claim = await placements.claimTurn(turn);
    await placements.updateAckCursors({ claim, liveEvent: 9 });
    await settleResult(claim);
    inventory.assertCurrent();
    expect(pendingChecks).toBe(6);
    expect([...inventory.placements]).toContainEqual({ ...active, lastLiveEventAckCursor: 9 });
    const current = await placements.prepareMaintenancePlacements();
    try {
      expect([...current.placements]).toContainEqual({ ...active, lastLiveEventAckCursor: 9 });
    } finally {
      current.release();
    }
    expect(queries.queries).toEqual([]);
  } finally {
    admission.mockRestore();
    inventory.release();
  }
});

it.each(["placement", "caller"] as const)(
  "rolls back both ACK cursor and terminal fence when %s authority is revoked before commit",
  async (owner) => {
    const claim = await workerClaim(`ack-revoked-${owner}`);
    const gate = createWorkerSessionPlacementGate(placements);
    const revoked = revokeAtAdmission("commit", () => {
      if (owner === "placement") {
        gate.fenceWorkerTurnForRecovery(claim);
      }
    });
    await expect(
      gate.updateAckCursors({
        claim,
        liveSeq: 1,
        assertCurrent: () => {
          if (owner === "caller" && revoked()) {
            throw new Error("ACK caller revoked");
          }
        },
      }),
    ).rejects.toThrow(owner === "placement" ? "stale worker turn" : "ACK caller revoked");
    expect(revoked()).toBe(true);
    expect(placements.get(claim.sessionId)?.lastLiveEventAckCursor).toBeNull();
    expect(await pendingResults(claim)).toEqual([]);
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
    expect(await pendingResults(claim)).toMatchObject([
      { claimId: claim.claimId, gatewayInstanceId: placements.workspaceResultInstanceId() },
    ]);
    // Fixture recovery settles the retained fence; an unknown ACK cannot release it.
    await settleResult(claim);
  },
);

it("claims and strictly releases local turns without host SQLite", async () => {
  using queries = observeSql();
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  try {
    const claim = await placements.claimTurn(input("sql-free"));
    expect(claim).toMatchObject({
      sessionId: "placement-worker-sql-free",
      claimId: "claim-sql-free",
      owner: { kind: "local" },
      placementGeneration: 0,
    });
    const released = await placements.releaseTurn(claim);
    expect(released).toMatchObject({ sessionId: claim.sessionId, state: "local", turnClaim: null });
    await expect(placements.releaseTurn(claim)).rejects.toThrow(
      "turn claim changed before release",
    );
    expect(queries.queries).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  } finally {
    exec.mockRestore();
  }
  expect(placements.get("placement-worker-sql-free")?.turnClaim).toBeNull();
});

it("publishes local claim and release facts before observers", async () => {
  const requested = input("local-projection");
  await placements.readProjection([requested.sessionId]);
  const snapshots: ReturnType<typeof placements.readPublishedProjection>[] = [];
  const stop = sessionChanges.subscribeProjection((change) => {
    if ("sessionKey" in change && change.sessionKey === requested.sessionKey) {
      snapshots.push(placements.readPublishedProjection(change));
    }
  });
  try {
    const claim = await placements.claimTurn(requested);
    await placements.releaseTurn(claim);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.placements.get(requested.sessionId)?.turnClaim?.claimId).toBe(
      requested.claimId,
    );
    expect(snapshots[1]?.placements.get(requested.sessionId)?.turnClaim).toBeNull();
    expect(placements.get(requested.sessionId)?.turnClaim).toBeNull();
  } finally {
    stop();
  }
});

it("replays the same local claim without replacing its identity or a successor", async () => {
  const requested = input("idempotent");
  const claim = await placements.claimTurn(requested);
  const replay = await placements.claimTurn(requested);
  expect(replay).toEqual(claim);
  await expect(placements.claimTurn({ ...requested, agentId: "another-agent" })).rejects.toThrow(
    "placement identity changed",
  );
  await expect(placements.claimTurn({ ...requested, runId: "another-run" })).rejects.toBeInstanceOf(
    ActiveTurnClaimError,
  );
  expect(placements.get(requested.sessionId)?.turnClaim).toMatchObject({
    claimId: requested.claimId,
    runId: requested.runId,
  });
  await placements.releaseTurn(replay);
  const successor = await placements.claimTurn({ ...requested, claimId: "successor" });
  await placements.releaseTurnIfOwned(claim);
  expect(placements.get(requested.sessionId)?.turnClaim?.claimId).toBe("successor");
  await placements.releaseTurn(successor);
});

it.each(["new local", "existing local", "worker"] as const)(
  "checks live publication exclusion for a %s turn",
  async (kind) => {
    let requested: WorkerTurnClaimInput = input(
      `publication-exclusion-${kind.replaceAll(" ", "-")}`,
    );
    if (kind === "existing local") {
      await placements.releaseTurn(await placements.claimTurn(requested));
    } else if (kind === "worker") {
      const active = await advancePlacementFixtureToActive(placements, database, requested, {
        environmentId: "publication-exclusion-environment",
      });
      requested = {
        ...requested,
        owner: placementTurnOwner(active),
      };
    }
    if (kind !== "worker") {
      await placements.withLocalWorkspaceReservation(requested, async (assertCurrent) => {
        assertCurrent();
        await expect(placements.claimTurn(requested)).rejects.toThrow("session workspace is busy");
      });
      const claimed = await placements.claimTurn(requested);
      expect(claimed.claimId).toBe(requested.claimId);
      await placements.releaseTurn(claimed);
      return;
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
  const [accepted, collision] = await Promise.allSettled([
    placements.claimTurn(first),
    placements.claimTurn(successor),
  ]);
  if (accepted.status !== "fulfilled" || collision.status !== "rejected") {
    throw new Error("Concurrent claim admission did not preserve its submitted order");
  }
  expect(collision.reason).toBeInstanceOf(ActiveTurnClaimError);
  const [, next] = await Promise.all([
    placements.releaseTurn(accepted.value),
    placements.claimTurn(successor),
    placements.releaseTurnIfOwned(accepted.value),
  ]);
  expect(placements.get(first.sessionId)?.turnClaim).toMatchObject({ claimId: successor.claimId });
  await placements.releaseTurn(next);
});

it("refuses a local claim before its effect when live authority is revoked", async () => {
  await expect(
    placements.claimTurn(input("refused"), () => {
      throw new Error("synthetic placement admission revoked");
    }),
  ).rejects.toThrow("synthetic placement admission revoked");
  expect(await placements.getAsync("placement-worker-refused")).toBeUndefined();
});

it.each(["claim", "staged result", "workspace manifest"] as const)(
  "returns committed %s custody after its real worker reply is corrupted",
  async (operation) => {
    const requested = await activeClaimInput(
      `lost-reply-${operation.replaceAll(" ", "-")}`,
      "remote-exec",
    );
    const ref = `refs/openclaw/worker-results/${requested.claimId}`;
    let stagedClaim: Awaited<ReturnType<typeof placements.claimTurn>> | undefined;
    if (operation !== "claim") {
      stagedClaim = await placements.claimTurn(requested);
      await placements.markWorkspaceResultPending(stagedClaim);
    }
    const corrupted = corruptReply((value) =>
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
        expect(await pendingResults(requested)).toMatchObject([
          { claimId: stagedClaim.claimId, stagedResultRef: ref },
        ]);
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
  const claim = await workerClaim("late-reply");
  const requested = { ...input("late-reply"), owner: claim.owner };
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
    const native = createPlacementTurnClaimOps({
      path: database.path,
      instanceId: "native-placement-fixture",
      now: () => 1_001,
      read: () => database.db,
      write: (operation) =>
        runOpenClawStateWriteTransaction(({ db }) => operation(db), { database }),
    });
    const replacement = native.claimTurn(requested).claim;
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

it("settles failed local startup without replaying it and admits the next turn", async () => {
  const claim = input("local-startup-failure");
  const startupError = new Error("local backend startup failed");
  let assertSettlementCurrent: (() => void) | undefined;
  const runLocal = vi.fn(async () => {
    assertSettlementCurrent = resolveSessionPlacementTurnSettlementAssertion();
    throw startupError;
  });
  await expect(executeLocalTurn({ claim, placements, runLocal })).rejects.toBe(startupError);
  expect(runLocal).toHaveBeenCalledOnce();
  expect(assertSettlementCurrent).toBeDefined();
  expect(() => assertSettlementCurrent?.()).toThrow("settlement is closed");
  expect(placements.get(claim.sessionId)?.turnClaim).toBeNull();
  await expect(
    executeLocalTurn({
      claim: { ...claim, runId: "local-startup-next" },
      placements,
      runLocal: async () => "next turn completed",
    }),
  ).resolves.toBe("next turn completed");
});

it.each(["reclaim", "mutation"] as const)(
  "continues and settles %s workspace custody without caller-thread SQL",
  async (purpose) => {
    const identity = await activeClaimInput(`result-${purpose}`, "remote-exec");
    const claimId = `reclaim-result-${purpose}`;
    const requested = {
      ...identity,
      claimId,
      runId: claimId,
    };
    using queries = observeSql();
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
    expect(await pendingResults(claim)).toMatchObject([
      { claimId, recoveryRequestedAtMs: 1_000, workspaceAcceptedAtMs: null },
    ]);
    await placements.acceptWorkspaceResult(claim);
    expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
    await placements.completeWorkspaceResultAndReleaseTurn(claim);
    expect(placements.validateWorkspaceResultClaim(claim)).toBe(false);
    expect(await pendingResults(claim)).toEqual([]);
    const cancelled = await placements.claimReclaimWorkspaceResult(requested);
    await placements.cancelWorkspaceResultAndReleaseTurn(cancelled);
    const abandoned = await placements.claimReclaimWorkspaceResult(requested);
    const [pending] = await pendingResults(abandoned);
    if (!pending) {
      throw new Error("Fixture lost its pending result");
    }
    await placements.abandonWorkspaceResult(pending);
    await placements.releaseTurn(abandoned);
    expect(queries.queries).toEqual([]);
  },
);

it("rejects result acceptance when the live caller is revoked before commit", async () => {
  const claim = await workerClaim("result-accept-revoked");
  await placements.markWorkspaceResultPending(claim);
  const revoked = revokeAtAdmission("commit");
  await expect(
    placements.acceptWorkspaceResult(claim, () => {
      if (revoked()) {
        throw new Error("result caller revoked");
      }
    }),
  ).rejects.toThrow("result caller revoked");
  expect((await pendingResults(claim))[0]?.workspaceAcceptedAtMs).toBeNull();
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
    try {
      expect(placements.validateWorkspaceResultClaim(next)).toBe(true);
      if (operation === "prepare") {
        await expect(placements.prepareWorkspaceResultClaim(previous)).rejects.toThrow(
          "workspace result authority changed",
        );
      } else {
        await placements.releaseTurnIfOwned(previous);
      }
      expect(await pendingResults(next)).toMatchObject([
        { claimId: next.claimId, runId: next.runId },
      ]);
      expect(placements.validateWorkspaceResultClaim(next)).toBe(true);
    } finally {
      await settleResult(next);
    }
  },
);
