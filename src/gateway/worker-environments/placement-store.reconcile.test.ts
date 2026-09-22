import { expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";

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
      seedAttachedPlacementEnvironment(database, {
        environmentId: `environment-${identity.sessionId}`,
        sessionId: identity.sessionId,
        ownerEpoch: 7,
      });
      let placement = store.startDispatch(identity);
      for (const step of [
        { to: "provisioning", patch: { environmentId: `environment-${identity.sessionId}` } },
        { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
        {
          to: "starting",
          patch: {
            workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
            remoteWorkspaceDir: `/workspace/${identity.sessionId}`,
          },
        },
        { to: "active", patch: { activeOwnerEpoch: 7 } },
      ] as const) {
        placement = store.transition({
          sessionId: identity.sessionId,
          from: placement.state,
          expectedGeneration: placement.generation,
          ...step,
        });
      }
      if (placement.state !== "active") {
        throw new Error("expected active worker placement");
      }
      return placement;
    }

    const localClaim = store.claimTurn({
      ...SESSION,
      sessionId: "local",
      owner: { kind: "local" },
      claimId: "local-claim",
      runId: "local-run",
    });
    store.releaseTurn(localClaim);
    const active = advanceToActive({ ...SESSION, sessionId: "reclaimed" });
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
      store.startDispatch({ ...SESSION, sessionId, sessionKey });
    }
    nowMs = 2_000;
    advanceToActive({ ...SESSION, sessionId: "cross-agent", agentId: "other" });
    nowMs = 3_000;
    for (const sessionId of ["requested-z", "requested-a"]) {
      store.startDispatch({ ...SESSION, sessionId });
    }
    nowMs = 4_000;
    store.startDispatch({ ...SESSION, sessionId: "failed" });
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
