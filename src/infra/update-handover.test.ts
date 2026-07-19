import { describe, expect, it } from "vitest";
import {
  runUpdateHandover,
  type UpdateConfirmationTier,
  type UpdateHandoverOperations,
} from "./update-handover.js";

function harness(
  options: {
    verify?: boolean;
    healthy?: boolean;
    confirmed?: boolean;
    tier?: UpdateConfirmationTier;
    failStop?: boolean;
    failCleanup?: boolean;
    failRollbackPhase?: boolean;
    failCompletePhase?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const operation =
    (name: string, fail = false) =>
    async () => {
      calls.push(name);
      if (fail) {
        throw new Error(`${name} failed`);
      }
    };
  const operations: UpdateHandoverOperations = {
    verifyNewPackage: async () => {
      calls.push("verify-package");
      return options.verify ?? true;
    },
    snapshotState: operation("snapshot-state"),
    swapPackage: operation("swap-package"),
    restartService: operation("restart-service"),
    waitForHealthy: async () => {
      calls.push("wait-healthy");
      return options.healthy ?? true;
    },
    waitForConfirmation: async (tier) => {
      calls.push(`wait-${tier}-confirmation`);
      return options.confirmed ?? true;
    },
    cleanupCompleted: operation("cleanup", options.failCleanup),
    onCleanupError: async () => {
      calls.push("cleanup-warning");
    },
    stopService: operation("stop-service", options.failStop),
    restorePackage: operation("restore-package"),
    restoreState: operation("restore-state"),
    startService: operation("start-service"),
    markFailed: async (reason) => {
      calls.push(`failed:${reason}`);
    },
    onPhase: async ({ phase }) => {
      calls.push(`phase:${phase}`);
      if (phase === "rolling-back" && options.failRollbackPhase) {
        throw new Error("phase persistence failed");
      }
      if (phase === "complete" && options.failCompletePhase) {
        throw new Error("complete persistence failed");
      }
    },
  };
  return {
    calls,
    run: () =>
      runUpdateHandover({
        ...operations,
        confirmationTier: options.tier ?? "delivery",
      }),
  };
}

describe("update handover", () => {
  it("runs the refined transaction sequence", async () => {
    const subject = harness();
    expect((await subject.run()).phase).toBe("complete");
    expect(subject.calls).toEqual([
      "phase:verify",
      "verify-package",
      "phase:snapshot",
      "snapshot-state",
      "phase:swap",
      "swap-package",
      "phase:restart",
      "restart-service",
      "wait-healthy",
      "phase:healthy",
      "phase:confirm",
      "wait-delivery-confirmation",
      "phase:complete",
      "cleanup",
    ]);
  });

  it("restores the retained package without snapshot or restart after verify failure", async () => {
    const subject = harness({ verify: false });
    expect((await subject.run()).phase).toBe("rolled-back");
    expect(subject.calls).toEqual([
      "phase:verify",
      "verify-package",
      "phase:rolling-back",
      "failed:new package startup verification failed",
      "restore-package",
      "phase:rolled-back",
    ]);
  });

  it("rolls back timeout in stop-package-state-start order", async () => {
    const subject = harness({ tier: "human", confirmed: false });
    expect((await subject.run()).phase).toBe("rolled-back");
    const stop = subject.calls.indexOf("stop-service");
    expect(subject.calls.slice(stop, stop + 4)).toEqual([
      "stop-service",
      "restore-package",
      "restore-state",
      "start-service",
    ]);
  });

  it("uses full rollback after health failure", async () => {
    const subject = harness({ healthy: false });
    expect((await subject.run()).failureReason).toBe("new gateway failed its health check");
    expect(subject.calls).not.toContain("wait-delivery-confirmation");
    expect(subject.calls).toContain("restore-state");
  });

  it("fails closed without restoring live files when stop fails", async () => {
    const subject = harness({ confirmed: false, failStop: true });
    await expect(subject.run()).rejects.toThrow("rollback failed: stop-service failed");
    expect(subject.calls).not.toContain("restore-package");
    expect(subject.calls).not.toContain("restore-state");
    expect(subject.calls).not.toContain("start-service");
    expect(subject.calls.at(-1)).toBe("phase:failed");
  });

  it("does not roll back a confirmed update when snapshot cleanup fails", async () => {
    const subject = harness({ failCleanup: true });
    expect((await subject.run()).phase).toBe("complete");
    expect(subject.calls).toContain("cleanup-warning");
    expect(subject.calls).not.toContain("stop-service");
  });

  it("does not roll back after confirmation when complete persistence fails", async () => {
    const subject = harness({ failCompletePhase: true });
    expect((await subject.run()).phase).toBe("complete");
    expect(subject.calls).toContain("cleanup");
    expect(subject.calls).not.toContain("stop-service");
  });

  it("rolls back even when phase persistence fails", async () => {
    const subject = harness({ confirmed: false, failRollbackPhase: true });
    expect((await subject.run()).phase).toBe("rolled-back");
    expect(subject.calls).toContain("stop-service");
    expect(subject.calls).toContain("restore-state");
  });
});
