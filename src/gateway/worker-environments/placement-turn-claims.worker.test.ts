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
import { StateDatabaseCoordinatorContentionError } from "../../infra/state-database-coordinator-errors.js";
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
import { ActiveTurnClaimError, createPlacementTurnClaimOps } from "./placement-turn-claims.js";
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

it("claims and strictly releases durable turns without host SQLite or coordinator exec", async () => {
  const queries = observeHostDataSql({ OPENCLAW_STATE_DIR: stateDir });
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

it("returns committed claim custody after its real worker reply is corrupted", async () => {
  const requested = input("lost-reply");
  const receive = brokerReply.receiveSqliteWorkerReply;
  let corrupted = 0;
  vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation(
    (slot, reply, owner, pumping) => {
      if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
        const value: unknown = deserialize(reply.value);
        if (isRecord(value) && isRecord(value.claim) && value.claim.claimId === requested.claimId) {
          corrupted += 1;
          return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner, pumping);
        }
      }
      return receive(slot, reply, owner, pumping);
    },
  );
  const claim = await placements.claimTurn(requested);
  expect(corrupted).toBe(1);
  expect(claim).toMatchObject({ claimId: requested.claimId, runId: requested.runId });
  expect(placements.get(claim.sessionId)?.turnClaim).toMatchObject({ claimId: requested.claimId });
  await placements.releaseTurn(claim);
  expect(placements.get(claim.sessionId)?.turnClaim).toBeNull();
});

it("keeps a later same-byte native claim authoritative when the old release reply arrives", async () => {
  const requested = input("late-reply");
  const claim = await placements.claimTurn(requested);
  const previous = await placements.prepareTurnClaimAuthority(claim);
  const replyArrived = createDeferredCore<() => void>();
  const receive = brokerReply.receiveSqliteWorkerReply;
  let delayed = false;
  vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation(
    (slot, reply, owner, pumping) => {
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
          replyArrived.resolve(() => receive(slot, reply, owner, pumping));
          return;
        }
      }
      return receive(slot, reply, owner, pumping);
    },
  );
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
            throw new StateDatabaseCoordinatorContentionError("state-lifecycle");
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

it.each(["ordinary", "forced"] as const)(
  "retains non-contention cleanup refusal across %s local completion",
  async (completion) => {
    const claim = input(`release-refused-${completion}`);
    const refused = new Error("release authority refused");
    const startupError = new Error("local backend startup failed");
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    const release = vi.spyOn(placements, "releaseTurnIfOwned");
    let forcedSettlement: (() => Promise<void>) | undefined;
    let forcedFailure: unknown;
    const runLocal = vi.fn(async () => {
      vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
        (admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "transaction") {
              throw refused;
            }
            admit(request, grant);
          }, attachment),
      );
      if (completion === "forced") {
        forcedSettlement = resolveSessionPlacementForcedTerminalSettlement();
        if (forcedSettlement) {
          try {
            await forcedSettlement();
          } catch (error) {
            forcedFailure = error;
          }
        }
      }
      throw startupError;
    });
    await expect(executeLocalTurn({ claim, placements, runLocal })).rejects.toBe(refused);
    if (completion === "forced") {
      expect(forcedSettlement).toBeTypeOf("function");
      expect(forcedFailure).toBe(refused);
    }
    expect(runLocal).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    const retained = release.mock.calls[0]![0];
    expect(placements.get(claim.sessionId)?.turnClaim).toMatchObject({ claimId: retained.claimId });
    // Only the fixture reauthorizes this refused cleanup; production must not retry it.
    await placements.releaseTurn(retained);
  },
);
