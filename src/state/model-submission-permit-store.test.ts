import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelSubmissionPermitStore } from "./model-submission-permit-store.js";
import { createModelTargetFenceStore } from "./model-target-fence-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const temporaryRoots: string[] = [];

function createStores() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-model-permit-"));
  temporaryRoots.push(root);
  const options = { path: path.join(root, "state.sqlite") };
  return {
    fences: createModelTargetFenceStore(options),
    permits: createModelSubmissionPermitStore(options),
  };
}

const target = {
  provider: "kalliope",
  model: "qwen3.6:35b-a3b",
  topologyGeneration: "mama-single-gpu-v7",
  fenceEpoch: 41,
  fenceToken: "fence-token-41",
} as const;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  temporaryRoots.length = 0;
});

describe("model submission permit store", () => {
  it("allows one active owner for a stable logical turn", () => {
    const { fences, permits } = createStores();
    fences.divertNew({ ...target, nowMs: 1_000 });
    fences.release({ ...target, nowMs: 1_100 });

    const first = permits.issue({
      agentId: "niemand",
      logicalTurnId: "telegram:update-1",
      attemptEpoch: 1,
      ownerId: "owner-a",
      runId: "run-a",
      provider: target.provider,
      model: target.model,
      nowMs: 1_200,
    });
    const raced = permits.issue({
      agentId: "niemand",
      logicalTurnId: "telegram:update-1",
      attemptEpoch: 1,
      ownerId: "owner-b",
      runId: "run-b",
      provider: target.provider,
      model: target.model,
      nowMs: 1_201,
    });

    expect(first.issued).toBe(true);
    expect(raced).toEqual({ issued: false, reason: "owned" });
  });

  it("atomically blocks new permits behind prepare recovery", () => {
    const { fences, permits } = createStores();
    fences.divertNew({ ...target, nowMs: 1_000 });
    fences.release({ ...target, nowMs: 1_100 });
    const oldPermit = permits.issue({
      agentId: "niemand",
      logicalTurnId: "telegram:update-old",
      attemptEpoch: 1,
      ownerId: "owner-old",
      runId: "run-old",
      provider: target.provider,
      model: target.model,
      nowMs: 1_150,
    });
    if (!oldPermit.issued) {
      throw new Error("expected old-generation permit");
    }
    const preparing = fences.prepareRecovery({
      ...target,
      fenceEpoch: 42,
      fenceToken: "prepare-token-42",
      nowMs: 1_200,
    });
    expect(preparing.state).toBe("active");

    expect(
      permits.issue({
        agentId: "niemand",
        logicalTurnId: "telegram:update-2",
        attemptEpoch: 1,
        ownerId: "owner-a",
        runId: "run-a",
        provider: target.provider,
        model: target.model,
        nowMs: 1_300,
      }),
    ).toEqual({ issued: false, reason: "fenced" });

    expect(permits.complete({ permitId: oldPermit.permit.permitId, nowMs: 1_400 })).toEqual({
      completed: true,
    });
    expect(fences.status().activeFences).toEqual([
      expect.objectContaining({ fenceEpoch: 42, state: "prepared" }),
    ]);
  });

  it("rejects late old-epoch completion after generation-death reconciliation", () => {
    const { fences, permits } = createStores();
    fences.divertNew({ ...target, nowMs: 1_000 });
    fences.release({ ...target, nowMs: 1_100 });
    const issued = permits.issue({
      agentId: "niemand",
      logicalTurnId: "telegram:update-3",
      attemptEpoch: 1,
      ownerId: "owner-a",
      runId: "run-a",
      provider: target.provider,
      model: target.model,
      nowMs: 1_200,
    });
    if (!issued.issued) {
      throw new Error("expected permit");
    }

    const prepared = fences.prepareRecovery({
      ...target,
      fenceEpoch: 42,
      fenceToken: "prepare-token-42",
      generationGoneProof: "worker-generation-v7-absent",
      nowMs: 1_300,
    });

    expect(prepared.state).toBe("prepared");
    expect(permits.complete({ permitId: issued.permit.permitId, nowMs: 1_400 })).toEqual({
      completed: false,
      reason: "stale",
    });
  });
});
