import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { REQUEST as SESSION } from "./placement-dispatch-test-fixtures.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";
import {
  placementClaim,
  placementSource,
  placementTransition,
} from "./placement-suite.test-support.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";

const fixture = usePlacementStoreFixture();

it("continues a committed dispatch after its real worker reply is corrupted", async () => {
  const { store } = fixture;
  const receive = brokerReply.receiveSqliteWorkerReply;
  let corrupted = 0;
  vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
    if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
      const value: unknown = deserialize(reply.value);
      if (
        isRecord(value) &&
        value.sessionId === SESSION.sessionId &&
        isRecord(value.placement) &&
        value.placement.state === "requested"
      ) {
        corrupted += 1;
        return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
      }
    }
    return receive(slot, reply, owner);
  });
  const placement = await store.startDispatch(SESSION);
  expect(corrupted).toBe(1);
  expect(placement).toEqual(store.get(SESSION.sessionId));
  expect(
    await store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: "environment-after-lost-reply" },
    }),
  ).toMatchObject({ state: "provisioning", generation: placement.generation + 1 });
});

it.each(["replaced", "cleanup", "claim", "move"] as const)(
  "rechecks the complete %s source in the redispatch transaction",
  async (scenario) => {
    const { store, database } = fixture;
    const request = {
      ...SESSION,
      executionMode: scenario === "claim" ? ("remote-exec" as const) : ("worker-turn" as const),
    };
    const active = await advancePlacementFixtureToActive(store, database, request);
    const owner = placementTransition(active);
    if (scenario === "claim") {
      await store.claimTurn(placementClaim(active, "previous"));
      // Older failed rows can retain a local claim without weakening today's drain contract.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(`UPDATE worker_session_placements SET state = 'failed',
              transition_generation = transition_generation + 3,
              recovery_error = 'previous worker failure', terminal_reason = 'previous worker failure',
              terminal_at_ms = 1 WHERE session_id = ?`).run(SESSION.sessionId);
        },
        { database },
      );
    } else {
      if (scenario === "move") {
        await store.beginPlacementMove({
          sessionId: SESSION.sessionId,
          source: placementSource(active),
          target: { kind: "gateway" },
        });
      }
      const draining =
        scenario === "move" ? store.get(SESSION.sessionId) : await store.startDrain(owner);
      if (draining?.state !== "draining") {
        throw new Error("expected draining worker placement");
      }
      const reconciling = await store.startReconcile({
        ...owner,
        expectedGeneration: draining.generation,
      });
      await store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "worker stopped",
      });
    }
    // The legacy-row fixture bypasses owner receipts, so reload its committed SQL state.
    const { placement: failed } = await store.getWithMoveAsync(SESSION.sessionId);
    if (failed?.state !== "failed") {
      throw new Error("expected failed worker placement");
    }
    writePlacementEnvironmentFixture(database, {
      environmentId: active.environmentId,
      state: scenario === "cleanup" ? "destroying" : "destroyed",
      ownerEpoch: active.activeOwnerEpoch + 1,
      attachedSessionIds: [],
    });
    if (scenario === "replaced") {
      const replacement = await store.startDispatch(request);
      await store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: replacement.generation,
        recoveryError: "replacement failed",
      });
    }
    const before = store.get(SESSION.sessionId);
    const dispatch = store.startDispatch({ ...request, expectedPlacement: failed });
    await expect(dispatch).rejects.toThrow(
      scenario === "replaced" || scenario === "claim"
        ? "changed before redispatch"
        : scenario === "cleanup"
          ? "still requires recovery"
          : "pending workspace recovery",
    );
    expect(store.get(SESSION.sessionId)).toEqual(before);
  },
);
