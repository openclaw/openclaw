import { expect, it, vi } from "vitest";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { cancelWorkerTurnClaimBoundApprovals } from "./approval-run-cancellation.js";

it("cancels only approvals bound to the exact fenced worker claim", async (testContext) => {
  const manager = createTestApprovalManager(testContext, {
    validateAgentRuntimeDelegatedAuthority: () => true,
  });
  const claim = {
    sessionId: "session-worker",
    claimId: "claim-worker",
    runId: "run-worker",
    placementGeneration: 4,
    owner: { kind: "worker" as const, environmentId: "environment-1", ownerEpoch: 7 },
  };
  const bind = async (id: string, ownerEpoch: number) => {
    const record = manager.create({ command: "echo ok", runId: claim.runId }, 60_000, id);
    record.agentRuntimeDelegatedAuthority = {
      kind: "worker",
      operationalRunInstance: { instanceId: `instance-${id}`, runId: claim.runId },
      lifecycleGeneration: "lifecycle-1",
      claimId: `run-claim-${id}`,
      turnClaim: { ...claim, owner: { ...claim.owner, ownerEpoch } },
    };
    const decision = (await manager.register(record, 60_000)).decision;
    return { record, decision };
  };
  const fenced = await bind("worker-fenced", 7);
  const successor = await bind("worker-successor", 8);
  const publish = vi.fn();

  expect(await cancelWorkerTurnClaimBoundApprovals({ claim, manager, publish })).toBe(1);
  await expect(fenced.decision).resolves.toBeNull();
  expect(successor.record.resolvedAtMs).toBeUndefined();
  expect(publish).toHaveBeenCalledOnce();
  await manager.forceDenyDetailed(
    successor.record.id,
    "run-aborted",
    { kind: "system", id: null },
    "cancelled",
  );
  await expect(successor.decision).resolves.toBeNull();
});
