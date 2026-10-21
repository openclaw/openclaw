import { describe, expect, it, vi } from "vitest";
import type { WorkerWorkspaceReconcileResult } from "./tunnel-contract.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";

function fixture() {
  const log: string[] = [];
  const record = (event: string) => async () => {
    log.push(event);
  };
  const reconciliation: WorkerWorkspaceReconcileResult = {
    manifestRef: "sha256:" + "c".repeat(64),
    changed: true,
    verifyStable: record("remote"),
    verifyLocalStable: record("local"),
    applyPreparedStagedResult: record("apply-prepared"),
    publishStagedResult: record("publish"),
    discardPreparedStagedResult: record("discard-prepared"),
  };
  const finalize = (assertActive = async () => {}) =>
    verifyReconciledWorkspaceFinal(reconciliation, { assertActive, resume: async () => {} });
  return { log, reconciliation, finalize, record };
}

describe("final worker workspace fences", () => {
  it.each([false, true])(
    "fences unchanged local state during acceptance after renewal (local failure: %s)",
    async (localFailure) => {
      const { log, reconciliation, finalize, record } = fixture();
      reconciliation.changed = false;
      reconciliation.acceptUnchangedStagedResult = async () => {
        log.push("local");
        if (localFailure) {
          throw new Error("local workspace changed");
        }
        log.push("accept");
      };
      reconciliation.discardPreparedStagedResult = record("discard");
      const result = finalize(record("renew"));
      if (localFailure) {
        await expect(result).rejects.toMatchObject({
          message: "local workspace changed",
          reclaimDisposition: "retry",
        });
        expect(log).toEqual(["renew", "remote", "local", "discard"]);
      } else {
        await result;
        expect(log).toEqual(["renew", "remote", "local", "accept", "publish"]);
      }
    },
  );

  it("rejects quiescence lost while the staged result is finalized", async () => {
    const { log, finalize } = fixture();
    let quiescenceChecks = 0;
    await expect(
      finalize(async () => {
        quiescenceChecks += 1;
        log.push("quiescence");
        if (quiescenceChecks === 2) {
          throw new Error("quiescence expired during finalization");
        }
      }),
    ).rejects.toMatchObject({
      message: "quiescence expired during finalization",
      reclaimDisposition: "preserve-result",
    });
    expect(log).toEqual([
      "quiescence",
      "remote",
      "apply-prepared",
      "local",
      "quiescence",
      "discard-prepared",
    ]);
  });

  it("rejects a late write enrolled by the pre-apply renewal before applying", async () => {
    let remoteChanged = false;
    const apply = vi.fn(async () => {});
    const { reconciliation, finalize } = fixture();
    reconciliation.applyPreparedStagedResult = apply;
    reconciliation.verifyStable = async () => {
      if (remoteChanged) {
        throw new Error("writer mutated before SIGSTOP");
      }
    };
    await expect(
      finalize(async () => {
        remoteChanged = true;
      }),
    ).rejects.toMatchObject({
      message: "writer mutated before SIGSTOP",
      reclaimDisposition: "retry",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("discards a prepared result when the final remote fence fails", async () => {
    const { log, reconciliation, finalize, record } = fixture();
    let applied = false;
    reconciliation.verifyStable = async () => {
      if (applied) {
        throw new Error("late remote write");
      }
    };
    reconciliation.applyPreparedStagedResult = async () => {
      await record("apply-prepared")();
      applied = true;
    };
    await expect(finalize()).rejects.toThrow("late remote write");
    expect(log).toEqual(["apply-prepared", "local", "discard-prepared"]);
  });

  it("best-effort discards a candidate when staged finalization fails", async () => {
    const discard = vi.fn(async () => {
      throw new Error("candidate cleanup failed");
    });
    const { reconciliation, finalize } = fixture();
    reconciliation.discardPreparedStagedResult = discard;
    reconciliation.publishStagedResult = async () => {
      throw new Error("publish failed");
    };
    await expect(finalize()).rejects.toThrow("publish failed");
    expect(discard).toHaveBeenCalledOnce();
  });
});
