import "./doctor-update.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { createManagedHandoffLeaseStore } from "../infra/update-managed-service-handoff-lease.js";

const {
  installDoctorUpdateTestHooks,
  mocks,
  mockGitCheckout,
  mockManagedService,
  mockUpdateResult,
  runOffer,
} = await import("./doctor-update.test-support.js");
installDoctorUpdateTestHooks();

describe("Doctor public update executor", () => {
  it("keeps the admitted owner through native restart and publishes only after release", async () => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
    });
    mockUpdateResult({
      status: "ok",
      mode: "git",
      root: "/repo/link",
      after: { version: "2026.4.24", buildId: "candidate-build" },
    });
    const store = createManagedHandoffLeaseStore();
    mocks.restartUpdatedGateway.mockImplementation(async () => {
      expect(store.read("/repo/link").kind).toBe("current");
      expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
    });
    mocks.completeUpdateCommandRun.mockImplementation((result, run) => {
      expect(store.read("/repo/link").kind).toBe("absent");
      expect(() => run?.executorFence?.assertCurrent()).toThrow();
      return { ...result, runId: run?.runId };
    });
    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).resolves.toEqual({
      updated: true,
      handled: true,
    });
    expect(mocks.restartUpdatedGateway).toHaveBeenCalledOnce();
    expect(mocks.waitForHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "2026.4.24", expectedBuildId: "candidate-build" }),
    );
    expect(mocks.waitForHttpReadiness).toHaveBeenCalledOnce();
    expect(mocks.completeUpdateCommandRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" }),
      await mocks.admitUpdateCommandRun.mock.results[0]!.value,
    );
  });
});

it.each(["missing", "replaced", "dropped-fence"] as const)(
  "refuses %s original authority after an awaited snapshot, before native effects",
  async (fault) => {
    mockGitCheckout();
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
    });
    mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
    const snapshot = await mocks.readConfigFileSnapshot();
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      await Promise.resolve();
      const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
      const store = createManagedHandoffLeaseStore();
      expect(store.read("/repo/link").kind).toBe("current");
      if (fault === "dropped-fence") {
        run.executorFence = undefined;
      } else {
        const { DatabaseSync } = await import("node:sqlite");
        const { resolveManagedUpdateLeaseDatabasePath } =
          await import("../infra/update-managed-service-handoff-lease.js");
        const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
        try {
          if (fault === "missing") {
            db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(
              "/repo/link",
            );
          } else {
            db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
              "revoked",
              "/repo/link",
            );
          }
        } finally {
          db.close();
        }
      }
      return snapshot;
    });
    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toThrow();
    expect(mocks.stopGatewayService).not.toHaveBeenCalled();
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.triageCommand).not.toHaveBeenCalled();
  },
);

it("retains a partial native stop and recovers with the same live run before failure publication", async () => {
  mockGitCheckout();
  const failure = new Error("native stop verification failed");
  const serviceEnv = { OPENCLAW_PROFILE: "work" };
  mocks.maybeStopManagedServiceBeforeMutableUpdate.mockImplementation(async (params) => {
    const state = {
      stopped: params.phase === "prepare",
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv,
      serviceUpdateVerdict: {
        kind: "owned",
        root: "/repo/link",
        refreshDefinition: false,
        fingerprint: "original",
      },
    };
    if (params.phase === "prepare") {
      params.onStopped(state);
      throw failure;
    }
    return state;
  });
  mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
  mocks.maybeRestartServiceAfterFailedMutableUpdate.mockImplementation(async (params) => {
    const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
    expect(params.updateRun).toBe(run);
    run.executorFence!.assertCurrent();
    expect(params.preManagedServiceStop).toMatchObject({ stopped: true, serviceEnv });
    expect(params.recovery).toMatchObject({
      serviceRestartSafe: true,
      version: "2026.4.23",
      buildId: "original-build",
    });
    return "healthy";
  });
  mocks.failUpdateCommandRun.mockImplementation((_error, run) => {
    expect(createManagedHandoffLeaseStore().read("/repo/link").kind).toBe("absent");
    expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).toHaveBeenCalledOnce();
    expect(run).toBeDefined();
  });
  await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toBe(failure);
  expect(mocks.failUpdateCommandRun).toHaveBeenCalledWith(
    failure,
    await mocks.admitUpdateCommandRun.mock.results[0]!.value,
  );
  expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
  expect(mocks.triageCommand).not.toHaveBeenCalled();
});

it.each(["restore", "complete"] as const)(
  "does not compensate or triage after a pending native %s refusal",
  async (phase) => {
    const { UpdateCommandRecoveryPendingError } =
      await import("../cli/update-cli/update-command-recovery.js");
    const pending = new UpdateCommandRecoveryPendingError(
      "original native authority remains pending",
    );
    mockGitCheckout();
    const recovery = {
      suspended: Promise.resolve(true),
      interrupted: () => false,
      handoff: vi.fn(),
      beginMutation: vi.fn(),
      restore: vi.fn(async () => {
        if (phase === "restore") {
          throw pending;
        }
      }),
      complete: vi.fn(async () => {
        if (phase === "complete") {
          throw pending;
        }
      }),
    };
    mockManagedService({
      verdict: { kind: "owned", refreshDefinition: false, fingerprint: "opaque" },
      autoStartRecovery: recovery,
    });
    mockUpdateResult({ status: "ok", mode: "git", root: "/repo/link" });
    await expect(runOffer({ confirm: vi.fn().mockResolvedValue(true) })).rejects.toBe(pending);
    expect(recovery.complete).toHaveBeenCalledTimes(phase === "complete" ? 1 : 0);
    expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
    expect(mocks.triageCommand).not.toHaveBeenCalled();
    expect(createManagedHandoffLeaseStore().read("/repo/link").kind).toBe("absent");
  },
);
