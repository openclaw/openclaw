import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveSessionPlacementForcedTerminalSettlement,
  resolveSessionPlacementTurnSettlementAssertion,
} from "../../agents/session-placement-forced-terminal-settlement.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
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

afterEach(() => vi.restoreAllMocks());

async function workerClaim(name: string) {
  const requested = input(name);
  const active = await advancePlacementFixtureToActive(placements, database, requested, {
    environmentId: `environment-${name}`,
  });
  return placements.claimTurn({
    ...requested,
    owner: {
      kind: "worker",
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    },
  });
}

function losePlacementReply(sessionId: string, outcome: "committed" | "unknown") {
  if (outcome === "unknown") {
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
  const receive = brokerReply.receiveSqliteWorkerReply;
  let corrupted = 0;
  vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
    if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
      const value: unknown = deserialize(reply.value);
      if (isRecord(value) && isRecord(value.placement) && value.placement.sessionId === sessionId) {
        corrupted += 1;
        return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
      }
    }
    return receive(slot, reply, owner);
  });
  return () => corrupted;
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
  const queries = observeHostDataSql();
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
    queries.restore();
  }
});

it.each(["delivered", "committed", "unknown"] as const)(
  "settles %s terminal-result failure before observers without caller-thread SQL",
  async (outcome) => {
    const claim = await workerClaim(`terminal-failure-boundary-${outcome}`);
    await placements.markWorkspaceResultPending(claim);
    const [pending] = await placements.listPendingWorkspaceResultsAsync(claim.sessionId);
    const authority = await placements.prepareTurnClaimAuthority(claim);
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
    const queries = observeHostDataSql();
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
      expect(queries.queries).toEqual([]);
    } finally {
      stop();
      authority.release();
      queries.restore();
    }
    expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses a transition when caller authority ends at %s admission",
  async (stage) => {
    const requested = await placements.startDispatch(input(`transition-revoked-${stage}`));
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    let revoked = false;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === stage) {
            revoked = true;
          }
          admit(request, grant);
        }, attachment),
    );
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
          if (revoked) {
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
  const queries = observeHostDataSql();
  try {
    await gate.updateAckCursors({ claim, transcriptSeq: 4 });
    await gate.updateAckCursors({ claim, liveSeq: 9 });
    await gate.updateAckCursors({ claim, transcriptSeq: 3, liveSeq: 8 });
    await gate.updateAckCursors({ claim, transcriptSeq: 4, liveSeq: 9 });
    expect(queries.queries).toEqual([]);
  } finally {
    queries.restore();
  }
  expect(placements.get(claim.sessionId)).toMatchObject({
    lastTranscriptAckCursor: 4,
    lastLiveEventAckCursor: 9,
  });
  expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toMatchObject([
    { claimId: claim.claimId, gatewayInstanceId: placements.workspaceResultInstanceId() },
  ]);
  await placements.acceptWorkspaceResult(claim);
  await gate.updateAckCursors({ claim, liveSeq: 9 });
  expect(
    (await placements.listPendingWorkspaceResultsAsync(claim.sessionId))[0]?.workspaceAcceptedAtMs,
  ).toBe(1_000);
  await placements.completeWorkspaceResultAndReleaseTurn(claim);
  await expect(gate.updateAckCursors({ claim, liveSeq: 10 })).rejects.toThrow("stale worker turn");
  expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
  expect(placements.get(claim.sessionId)?.lastLiveEventAckCursor).toBe(9);
});

it.each(["placement", "caller"] as const)(
  "rolls back both ACK cursor and terminal fence when %s authority is revoked before commit",
  async (owner) => {
    const claim = await workerClaim(`ack-revoked-${owner}`);
    const gate = createWorkerSessionPlacementGate(placements);
    let revoked = false;
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            revoked = true;
            if (owner === "placement") {
              gate.fenceWorkerTurnForRecovery(claim);
            }
          }
          admit(request, grant);
        }, attachment),
    );
    await expect(
      gate.updateAckCursors({
        claim,
        liveSeq: 1,
        assertCurrent: () => {
          if (owner === "caller" && revoked) {
            throw new Error("ACK caller revoked");
          }
        },
      }),
    ).rejects.toThrow(owner === "placement" ? "stale worker turn" : "ACK caller revoked");
    expect(revoked).toBe(true);
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
    expect(placements.get(claim.sessionId)?.lastLiveEventAckCursor).toBe(1);
    expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toMatchObject([
      { claimId: claim.claimId, gatewayInstanceId: placements.workspaceResultInstanceId() },
    ]);
    // Fixture recovery settles the retained fence; an unknown ACK cannot release it.
    await placements.acceptWorkspaceResult(claim);
    await placements.completeWorkspaceResultAndReleaseTurn(claim);
  },
);

it("claims and strictly releases durable turns without host SQLite", async () => {
  const queries = observeHostDataSql();
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
    queries.restore();
  }
  expect(placements.get("placement-worker-sql-free")?.turnClaim).toBeNull();
});

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

it("rolls back claim admission when live authority is revoked at commit", async () => {
  let revoked = false;
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
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
    placements.claimTurn(input("refused"), () => {
      if (revoked) {
        throw new Error("synthetic placement admission revoked");
      }
    }),
  ).rejects.toThrow("synthetic placement admission revoked");
  expect(revoked).toBe(true);
  expect(placements.get("placement-worker-refused")).toBeUndefined();
});

it("fences retained authority before release commit and closes observers after settlement", async () => {
  const claim = await placements.claimTurn(input("authority"));
  const authority = await placements.prepareTurnClaimAuthority(claim);
  const revoked = vi.fn();
  const closed = vi.fn();
  const unsubscribe = placements.registerTurnClaimClosedHandler(closed);
  authority.onRevoked(revoked);
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  let commitObservation: { current: boolean; revoked: number; closed: number } | undefined;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (admit, attachment) =>
      createAdmission((request, grant) => {
        admit(request, grant);
        if (request.stage === "commit") {
          commitObservation = {
            current: authority.isCurrent(),
            revoked: revoked.mock.calls.length,
            closed: closed.mock.calls.length,
          };
        }
      }, attachment),
  );
  try {
    const released = placements.waitForTurnClaimRelease(claim.sessionId, {});
    await placements.releaseTurn(claim);
    await released;
    expect(commitObservation).toEqual({ current: false, revoked: 0, closed: 0 });
    expect(authority.isCurrent()).toBe(false);
    expect(revoked).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledExactlyOnceWith(claim);
  } finally {
    unsubscribe();
    authority.release();
  }
});

it.each(["claim", "staged result", "workspace manifest"] as const)(
  "returns committed %s custody after its real worker reply is corrupted",
  async (operation) => {
    const requested = input(`lost-reply-${operation.replaceAll(" ", "-")}`);
    const ref = `refs/openclaw/worker-results/${requested.claimId}`;
    let stagedClaim: Awaited<ReturnType<typeof placements.claimTurn>> | undefined;
    if (operation !== "claim") {
      const active = await advancePlacementFixtureToActive(
        placements,
        database,
        {
          sessionId: requested.sessionId,
          agentId: requested.agentId,
          sessionKey: requested.sessionKey,
          executionMode: "remote-exec",
        },
        { environmentId: `lost-reply-environment-${operation.replaceAll(" ", "-")}` },
      );
      stagedClaim = await placements.claimTurn({
        ...requested,
        owner: {
          kind: "local",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      await placements.markWorkspaceResultPending(stagedClaim);
    }
    const receive = brokerReply.receiveSqliteWorkerReply;
    let corrupted = 0;
    vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
      if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
        const value: unknown = deserialize(reply.value);
        const matches =
          isRecord(value) &&
          (operation === "claim"
            ? isRecord(value.claim) && value.claim.claimId === requested.claimId
            : isRecord(value.placement) && value.placement.sessionId === requested.sessionId);
        if (matches) {
          corrupted += 1;
          return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
        }
      }
      return receive(slot, reply, owner);
    });
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
      expect(corrupted).toBe(1);
      await placements.acceptWorkspaceResult(stagedClaim);
      await placements.completeWorkspaceResultAndReleaseTurn(stagedClaim);
    } else {
      const claim = await placements.claimTurn(requested);
      expect(corrupted).toBe(1);
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
  const deliver = await replyArrived.promise;
  let delivered = false;
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
    const replacement = native.claimTurn(requested);
    next = await placements.prepareTurnClaimAuthority(replacement);
    expect(next.isCurrent()).toBe(true);
    delivered = true;
    deliver();
    await releasing;
    expect(previous.isCurrent()).toBe(false);
    expect(next.isCurrent()).toBe(true);
    expect(placements.get(claim.sessionId)?.turnClaim).toMatchObject({
      claimId: requested.claimId,
    });
    await placements.releaseTurn(replacement);
  } finally {
    if (!delivered) {
      deliver();
    }
    await Promise.allSettled([releasing]);
    previous.release();
    next?.release();
  }
});

it("settles a failed local startup after precommit release contention without replaying it", async () => {
  const claim = input("local-startup-busy");
  const startupError = new Error("local backend startup failed");
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  let assertSettlementCurrent: (() => void) | undefined;
  const runLocal = vi.fn(async () => {
    assertSettlementCurrent = resolveSessionPlacementTurnSettlementAssertion();
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "transaction") {
            throw Object.assign(new Error("database is locked"), {
              code: "ERR_SQLITE_ERROR",
              errcode: 5,
            });
          }
          admit(request, grant);
        }, attachment),
    );
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

it.each(["authority", "entered writer"] as const)(
  "retains %s cleanup refusal from forced settlement through ordinary completion",
  async (failure) => {
    const claim = input(`release-refused-forced-${failure}`);
    const refused =
      failure === "authority"
        ? new Error("release authority refused")
        : Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    const startupError = new Error("local backend startup failed");
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    const release = vi.spyOn(placements, "releaseTurnIfOwned");
    let forcedSettlement: (() => Promise<void>) | undefined;
    let forcedFailure: unknown;
    const runLocal = vi.fn(async () => {
      vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
        (admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === (failure === "authority" ? "transaction" : "commit")) {
              throw refused;
            }
            admit(request, grant);
          }, attachment),
      );
      forcedSettlement = resolveSessionPlacementForcedTerminalSettlement();
      if (forcedSettlement) {
        try {
          await forcedSettlement();
        } catch (error) {
          forcedFailure = error;
        }
      }
      throw startupError;
    });
    await expect(executeLocalTurn({ claim, placements, runLocal })).rejects.toBe(refused);
    expect(forcedSettlement).toBeTypeOf("function");
    expect(forcedFailure).toBe(refused);
    expect(runLocal).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    const retained = release.mock.calls[0]![0];
    expect(placements.get(claim.sessionId)?.turnClaim).toMatchObject({ claimId: retained.claimId });
    // Only the fixture reauthorizes this refused cleanup; production must not retry it.
    await placements.releaseTurn(retained);
  },
);

it.each(["reclaim", "mutation"] as const)(
  "continues and settles %s workspace custody without caller-thread SQL",
  async (purpose) => {
    const identity = input(`result-${purpose}`);
    const active = await advancePlacementFixtureToActive(
      placements,
      database,
      {
        ...identity,
        executionMode: "remote-exec",
      },
      { environmentId: `result-environment-${purpose}` },
    );
    const claimId = `reclaim-result-${purpose}`;
    const requested = {
      ...identity,
      claimId,
      runId: claimId,
      owner: {
        kind: "local" as const,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    };
    const queries = observeHostDataSql();
    try {
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
      const cancelled = await placements.claimReclaimWorkspaceResult(requested);
      await placements.cancelWorkspaceResultAndReleaseTurn(cancelled);
      const abandoned = await placements.claimReclaimWorkspaceResult(requested);
      const [pending] = await placements.listPendingWorkspaceResultsAsync(abandoned.sessionId);
      if (!pending) {
        throw new Error("Fixture lost its pending result");
      }
      await placements.abandonWorkspaceResult(pending);
      await placements.releaseTurn(abandoned);
      expect(queries.queries).toEqual([]);
    } finally {
      queries.restore();
    }
  },
);

it("rejects result acceptance when the live caller is revoked before commit", async () => {
  const claim = await workerClaim("result-accept-revoked");
  await placements.markWorkspaceResultPending(claim);
  let revoked = false;
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
    (admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          revoked = true;
        }
        admit(request, grant);
      }, attachment),
  );
  await expect(
    placements.acceptWorkspaceResult(claim, () => {
      if (revoked) {
        throw new Error("result caller revoked");
      }
    }),
  ).rejects.toThrow("result caller revoked");
  expect(
    (await placements.listPendingWorkspaceResultsAsync(claim.sessionId))[0]?.workspaceAcceptedAtMs,
  ).toBeNull();
  expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
  await placements.acceptWorkspaceResult(claim);
  await placements.completeWorkspaceResultAndReleaseTurn(claim);
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
      expect(await placements.listPendingWorkspaceResultsAsync(next.sessionId)).toMatchObject([
        { claimId: next.claimId, runId: next.runId },
      ]);
      expect(placements.validateWorkspaceResultClaim(next)).toBe(true);
    } finally {
      await placements.acceptWorkspaceResult(next);
      await placements.completeWorkspaceResultAndReleaseTurn(next);
    }
  },
);
