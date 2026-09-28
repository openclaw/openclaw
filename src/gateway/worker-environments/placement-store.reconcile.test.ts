import { expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement",
  agentId: "main",
  sessionKey: "agent:main:placement",
};

it("filters reconciliation by exact session key across agents while preserving state and order", async () => {
  await withOpenClawTestState({ label: "placement-reconcile" }, async (testState) => {
    const database = openOpenClawStateDatabase({ env: testState.env });
    let nowMs = 1_000;
    const store = createWorkerSessionPlacementStore({ database, now: () => nowMs });

    function advanceToActive(identity: WorkerSessionPlacementIdentity) {
      return advancePlacementFixtureToActive(store, database, identity, {
        environmentId: `environment-${identity.sessionId}`,
        remoteWorkspaceDir: `/workspace/${identity.sessionId}`,
        seedEnvironment: "before-dispatch",
      });
    }

    const localClaim = await store.claimTurn({
      ...SESSION,
      sessionId: "local",
      owner: { kind: "local" },
      claimId: "local-claim",
      runId: "local-run",
    });
    await store.releaseTurn(localClaim);
    const active = await advanceToActive({ ...SESSION, sessionId: "reclaimed" });
    const draining = store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = store.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    store.transition({
      sessionId: active.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    for (const [sessionId, sessionKey] of [
      ["unrelated-case", SESSION.sessionKey.toUpperCase()],
      ["unrelated-child", `${SESSION.sessionKey}:child`],
    ] as const) {
      await store.startDispatch({ ...SESSION, sessionId, sessionKey });
    }
    nowMs = 2_000;
    await advanceToActive({ ...SESSION, sessionId: "cross-agent", agentId: "other" });
    nowMs = 3_000;
    for (const sessionId of ["requested-z", "requested-a"]) {
      await store.startDispatch({ ...SESSION, sessionId });
    }
    nowMs = 4_000;
    await store.startDispatch({ ...SESSION, sessionId: "failed" });
    store.fail({ sessionId: "failed", recoveryError: "dispatch failed" });

    expect(
      store.listForReconcile(SESSION.sessionKey).map(({ sessionId, state }) => [sessionId, state]),
    ).toEqual([
      ["cross-agent", "active"],
      ["requested-a", "requested"],
      ["requested-z", "requested"],
      ["failed", "failed"],
    ]);
    expect(store.listForReconcile().map((record) => record.sessionId)).toEqual([
      "unrelated-case",
      "unrelated-child",
      "cross-agent",
      "requested-a",
      "requested-z",
      "failed",
    ]);
    for (const sessionKey of ["agent:main:absent", "", ` ${SESSION.sessionKey} `]) {
      expect(store.listForReconcile(sessionKey)).toEqual([]);
    }
  });
});
