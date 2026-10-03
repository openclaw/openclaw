import { describe, expect, it, vi } from "vitest";
import {
  runInstrumentedWorkspaceReconcile,
  verifyReconciledWorkspaceFinal,
} from "./workspace-finalize.js";

const workspaceDebug = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-workspace"
        ? { ...logger, debug: workspaceDebug }
        : logger;
    },
  };
});

const emptyStaging = {
  publishStagedResult: async () => {},
  discardPreparedStagedResult: async () => {},
};

describe("final worker workspace fences", () => {
  it("rechecks remote and local stability after the final quiescence renewal", async () => {
    const log: string[] = [];
    workspaceDebug.mockClear();
    const reconciliation = await runInstrumentedWorkspaceReconcile(async () => ({
      ...emptyStaging,
      manifestRef: "sha256:" + "a".repeat(64),
      changed: true,
      verifyStable: async () => {
        log.push("remote");
      },
      verifyLocalStable: async () => {
        log.push("local");
      },
    }));
    expect(workspaceDebug).not.toHaveBeenCalled();
    await verifyReconciledWorkspaceFinal(reconciliation, {
      assertActive: async () => {
        log.push("quiescence");
      },
      resume: async () => {},
    });

    expect(log).toEqual(["quiescence", "remote", "local", "quiescence", "remote", "local"]);
    expect(workspaceDebug).toHaveBeenCalledExactlyOnceWith(
      "worker workspace reconcile completed",
      expect.objectContaining({ outcome: "succeeded" }),
    );
  });

  it.each([false, true])(
    "fences unchanged local state during acceptance after renewal (local failure: %s)",
    async (localFailure) => {
      const log: string[] = [];
      const finalize = verifyReconciledWorkspaceFinal(
        {
          ...emptyStaging,
          manifestRef: "sha256:" + "a".repeat(64),
          changed: false,
          verifyStable: async () => {
            log.push("remote");
          },
          verifyLocalStable: async () => {},
          acceptUnchangedStagedResult: async () => {
            log.push("local");
            if (localFailure) {
              throw new Error("local workspace changed");
            }
            log.push("accept");
          },
          publishStagedResult: async () => {
            log.push("publish");
          },
          discardPreparedStagedResult: async () => {
            log.push("discard");
          },
        },
        {
          assertActive: async () => {
            log.push("renew");
          },
          resume: async () => {},
        },
      );
      if (localFailure) {
        await expect(finalize).rejects.toMatchObject({
          message: "local workspace changed",
          reclaimDisposition: "retry",
        });
        expect(log).toEqual(["renew", "remote", "local", "discard"]);
      } else {
        await finalize;
        expect(log).toEqual(["renew", "remote", "local", "accept", "publish"]);
      }
    },
  );

  it.each([true, false])("publishes under quiescence with local apply %s", async (applyLocally) => {
    const log: string[] = [];
    await verifyReconciledWorkspaceFinal(
      {
        ...emptyStaging,
        manifestRef: "sha256:" + "b".repeat(64),
        changed: true,
        verifyStable: async () => {
          log.push("remote");
        },
        verifyLocalStable: async () => {
          log.push("local");
        },
        ...(applyLocally
          ? {
              applyPreparedStagedResult: async () => {
                log.push("apply-prepared");
              },
            }
          : {}),
        publishStagedResult: async () => {
          log.push("publish");
        },
      },
      {
        assertActive: async () => {
          log.push("quiescence");
        },
        resume: async () => {},
      },
    );
    expect(log).toEqual([
      "quiescence",
      "remote",
      ...(applyLocally ? ["apply-prepared"] : []),
      "local",
      "quiescence",
      "remote",
      "local",
      "publish",
    ]);
  });

  it("rejects quiescence lost while the staged result is finalized", async () => {
    const log: string[] = [];
    let quiescenceChecks = 0;
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          ...emptyStaging,
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: async () => {
            log.push("remote");
          },
          verifyLocalStable: async () => {
            log.push("local");
          },
          applyPreparedStagedResult: async () => {
            log.push("apply-prepared");
          },
          publishStagedResult: async () => {
            log.push("publish");
          },
          discardPreparedStagedResult: async () => {
            log.push("discard-prepared");
          },
        },
        {
          assertActive: async () => {
            quiescenceChecks += 1;
            log.push("quiescence");
            if (quiescenceChecks === 2) {
              throw new Error("quiescence expired during finalization");
            }
          },
          resume: async () => {},
        },
      ),
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
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          ...emptyStaging,
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: async () => {
            if (remoteChanged) {
              throw new Error("writer mutated before SIGSTOP");
            }
          },
          verifyLocalStable: async () => {},
          applyPreparedStagedResult: apply,
          publishStagedResult: async () => {},
        },
        {
          assertActive: async () => {
            remoteChanged = true;
          },
          resume: async () => {},
        },
      ),
    ).rejects.toMatchObject({
      message: "writer mutated before SIGSTOP",
      reclaimDisposition: "retry",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("discards a prepared result when the final remote fence fails", async () => {
    const log: string[] = [];
    let applied = false;
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          ...emptyStaging,
          manifestRef: "sha256:" + "c".repeat(64),
          changed: true,
          verifyStable: async () => {
            if (applied) {
              throw new Error("late remote write");
            }
          },
          verifyLocalStable: async () => {
            log.push("local");
          },
          applyPreparedStagedResult: async () => {
            log.push("apply-prepared");
            applied = true;
          },
          publishStagedResult: async () => {
            log.push("publish");
          },
          discardPreparedStagedResult: async () => {
            log.push("discard-prepared");
          },
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toThrow("late remote write");
    expect(log).toEqual(["apply-prepared", "local", "discard-prepared"]);
  });

  it("best-effort discards a candidate when staged finalization fails", async () => {
    const discard = vi.fn(async () => {
      throw new Error("candidate cleanup failed");
    });
    await expect(
      verifyReconciledWorkspaceFinal(
        {
          ...emptyStaging,
          manifestRef: "sha256:" + "d".repeat(64),
          changed: true,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
          applyPreparedStagedResult: async () => {},
          publishStagedResult: async () => {
            throw new Error("publish failed");
          },
          discardPreparedStagedResult: discard,
        },
        { assertActive: async () => {}, resume: async () => {} },
      ),
    ).rejects.toThrow("publish failed");
    expect(discard).toHaveBeenCalledOnce();
  });
});
