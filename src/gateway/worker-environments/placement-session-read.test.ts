import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { stagePlacementTurnClaimWorkerPublication } from "./placement-turn-authority.js";

it("retains SQL-free placement facts through claims, dispatch, retirement and uncertain writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database });
    const session = {
      agentId: "main",
      sessionKey: "agent:main:retained-placement",
      sessionId: "retained-placement",
    };
    const read = await store.prepareSessionPlacement(session.sessionId);
    const current = () => {
      const sql = observeHostDataSql();
      try {
        const placement = read.current();
        expect(sql.queries).toEqual([]);
        return placement;
      } finally {
        sql.restore();
      }
    };
    try {
      expect(current()).toBeUndefined();
      const claim = await store.claimTurn({
        ...session,
        owner: { kind: "local" },
        runId: "local-run",
        claimId: "local-claim",
      });
      expect(current()).toMatchObject({ state: "local", turnClaim: { claimId: claim.claimId } });
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
      const identity = requireOpenClawStateDatabaseIdentity({ db: database.db });
      const publication = () =>
        stagePlacementTurnClaimWorkerPublication(identity, failed, undefined, failed.state, failed);
      const pending = publication();
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
