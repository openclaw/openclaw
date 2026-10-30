import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import {
  stagePlacementTurnClaimWorkerPublication,
  stagePlacementWorkspaceJournalWorkerPublication,
  stagePlacementWorkspaceResultWorkerPublication,
} from "./placement-turn-authority.js";

function withoutHostSql<T>(read: () => T): T {
  const sql = observeHostDataSql();
  try {
    const result = read();
    expect(sql.queries).toEqual([]);
    return result;
  } finally {
    sql.restore();
  }
}

it("retains SQL-free placement facts through bookkeeping, claims, dispatch, retirement and uncertain writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database });
    const session = {
      agentId: "main",
      sessionKey: "agent:main:retained-placement",
      sessionId: "retained-placement",
    };
    const read = await store.prepareSessionPlacement(session.sessionId);
    const current = () => withoutHostSql(() => read.current());
    try {
      expect(current()).toBeUndefined();
      {
        using keys = vi.spyOn(Object, "keys");
        const warm = await store.prepareSessionPlacement(session.sessionId);
        expect(warm.current()).toBeUndefined();
        warm.release();
        expect(keys.mock.calls.filter(([source]) => source === process.env)).toHaveLength(0);
      }
      const claim = await store.claimTurn({
        ...session,
        owner: { kind: "local" },
        runId: "local-run",
        claimId: "local-claim",
      });
      expect(current()).toMatchObject({ state: "local", turnClaim: { claimId: claim.claimId } });
      const expectedLocal = {
        ...session,
        state: "local",
        turnClaim: { claimId: claim.claimId },
      };
      for (const fetch of [
        () => store.getAsync(session.sessionId),
        async () => (await store.listAsync()).find((row) => row.sessionId === session.sessionId),
      ]) {
        const fetched = (await fetch())!;
        fetched.agentId = "caller-mutated-agent";
        fetched.turnClaim!.claimId = "caller-mutated-claim";
        expect(current()).toMatchObject(expectedLocal);
      }
      expect(store.validateTurnClaim(claim)).toBe(true);
      const identity = requireOpenClawStateDatabaseIdentity({ db: database.db });
      const beforeResult = current()!;
      const afterResult = { ...beforeResult, updatedAtMs: beforeResult.updatedAtMs + 1 };
      const resultPublication = stagePlacementWorkspaceResultWorkerPublication(
        identity,
        session.sessionId,
        { placement: afterResult, pendingResult: undefined },
      );
      expect(current()).toEqual(beforeResult);
      resultPublication.commit();
      expect(current()).toEqual(afterResult);
      const journalPublication = stagePlacementWorkspaceJournalWorkerPublication(
        identity,
        session.sessionId,
        true,
      );
      expect(current()).toEqual(afterResult);
      journalPublication.rollback();
      const local = await store.releaseTurn(claim);
      expect(current()).toEqual(local);
      await store.retireSessionPlacementAsync({
        sessionId: session.sessionId,
        expectedState: "local",
        expectedGeneration: local.generation,
      });
      expect(current()).toBeUndefined();
      const requested = await store.startDispatch({ ...session, executionMode: "worker-turn" });
      expect(current()).toEqual(requested);
      const failed = await store.fail({
        sessionId: session.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "synthetic provider unavailable",
      });
      expect(current()).toEqual(failed);
      const publication = () =>
        stagePlacementTurnClaimWorkerPublication(identity, failed, undefined, failed.state, failed);
      const pending = publication();
      expect(() => read.prepareRead()).toThrow("placement authority changed");
      expect(() => current()).toThrow("placement authority changed");
      pending.rollback();
      expect(current()).toEqual(failed);
      publication().invalidate();
      expect(() => current()).toThrow("placement authority changed");
    } finally {
      read.release();
    }
    expect(() => current()).toThrow("placement authority changed");
    // A second release must not remove a newer reader's publication subscription.
    const replacement = await store.prepareSessionPlacement(session.sessionId);
    try {
      read.release();
      await store.retireSessionPlacementAsync({
        sessionId: session.sessionId,
        expectedState: "failed",
        expectedGeneration: replacement.current()!.generation,
      });
      expect(replacement.current()).toBeUndefined();
    } finally {
      replacement.release();
    }
  });
});

it("installs the committed placement when acquisition overlaps its writer receipt", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const store = createWorkerSessionPlacementStore();
    const session = {
      agentId: "main",
      sessionKey: "agent:main:placement-acquisition",
      sessionId: "placement-acquisition",
    };
    const getAsync = store.getAsync.bind(store);
    let committed: Awaited<ReturnType<typeof store.startDispatch>> | undefined;
    using read = vi.spyOn(store, "getAsync");
    read.mockImplementationOnce(async (sessionId) => {
      const prior = await getAsync(sessionId);
      committed = await store.startDispatch(session);
      return prior;
    });
    const retained = await store.prepareSessionPlacement(session.sessionId);
    try {
      expect(withoutHostSql(() => retained.current())).toEqual(committed);
    } finally {
      retained.release();
    }
  });
});

it("keeps cold async worker placement results independent of retained placement facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database });
    const session = {
      agentId: "main",
      sessionKey: "agent:main:caller-owned-placement",
      sessionId: "caller-owned-placement",
    };
    expect(await store.getManyAsync([session.sessionId])).toEqual(new Map());
    expect(withoutHostSql(() => store.getMany([session.sessionId]))).toEqual(new Map());
    const environment = { environmentId: "caller-owned-environment", ownerEpoch: 7 };
    await advancePlacementFixtureToActive(store, database, session, environment);
    await store.claimTurn({
      ...session,
      owner: { kind: "worker", ...environment },
      runId: "caller-owned-run",
      claimId: "caller-owned-claim",
    });
    await closeOpenClawStateDatabaseAsync();
    openOpenClawStateDatabase();
    const reopened = createWorkerSessionPlacementStore();
    expect(() => reopened.get(session.sessionId)).toThrow("Await getAsync");
    const result = (await reopened.getManyAsync([session.sessionId])).get(session.sessionId)!;
    expect(result).toMatchObject({
      ...session,
      state: "active",
      turnClaim: { claimId: "caller-owned-claim" },
    });
    result.agentId = "caller-mutated-agent";
    result.turnClaim!.claimId = "caller-mutated-claim";
    expect(reopened.get(session.sessionId)).toMatchObject({
      ...session,
      turnClaim: { claimId: "caller-owned-claim" },
    });
    expect((await reopened.getManyAsync([session.sessionId])).get(session.sessionId)).toMatchObject(
      {
        ...session,
        turnClaim: { claimId: "caller-owned-claim" },
      },
    );
  });
});
