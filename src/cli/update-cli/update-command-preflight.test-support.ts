import fsSync from "node:fs";
import fs from "node:fs/promises";
import { expect, it, vi, type Mock } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { readRestartSentinelReadOnly } from "../../infra/restart-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import type { RetainUpdateRuntime } from "../../infra/update-retained-runtime.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";

type UpdatePreflightFixture = {
  mockPackageInstallAtCaseDir: () => Promise<string>;
  statfsFixture: (params: {
    bavail: number;
    bsize?: number;
    blocks?: number;
  }) => ReturnType<typeof fsSync.statfsSync>;
  resolveNpmChannelTag: typeof import("../../infra/update-check.js").resolveNpmChannelTag;
  fetchNpmPackageTargetStatus: typeof import("../../infra/update-check-package-target.js").fetchNpmPackageTargetStatus;
  listUpdateRuns: typeof import("../../infra/update-run-ledger.js").listUpdateRuns;
  updateCommand: typeof import("./update-command.js").updateCommand;
  getLogOutput: () => string;
  getErrorOutput: () => string;
  lastWriteJsonCall: () => unknown;
  expectPackageInstallSpec: (spec: string) => void;
  packageInstallCommandCall: () => [string[], Record<string, unknown>] | undefined;
  defaultRuntime: typeof import("../../runtime.js").defaultRuntime;
  retainUpdateRuntime: Mock<RetainUpdateRuntime>;
  initializeExistingUpdateProfile: () => void;
  profileStateDir: () => string;
  makeTempDir: (prefix: string) => string;
};

export function registerUpdatePreflightTests(f: UpdatePreflightFixture) {
  const latestRun = () => f.listUpdateRuns({ limit: 1 })[0];
  const containingStep = (step: object) => expect.arrayContaining([expect.objectContaining(step)]);
  const expectLatestStep = (step: object) =>
    expect(latestRun()?.steps).toEqual(containingStep(step));
  const diskSpace = (bavail: number) =>
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(f.statfsFixture({ bavail, bsize: 1024 * 1024 }));

  it("reports low disk space before target lookup and persists it after admission", async () => {
    await f.mockPackageInstallAtCaseDir();
    const historyBefore = f.listUpdateRuns();
    diskSpace(256);
    const targetLookups: Array<{ output: string; history: UpdateRunRecord[] }> = [];
    const resolveTag = vi.mocked(f.resolveNpmChannelTag).getMockImplementation()!;
    vi.mocked(f.resolveNpmChannelTag).mockImplementation(async (...args) => {
      targetLookups.push({
        output: f.getLogOutput(),
        history: f.listUpdateRuns(),
      });
      return await resolveTag(...args);
    });

    await f.updateCommand({ yes: true });

    expect(targetLookups).toContainEqual({
      output: expect.stringContaining("Low disk space near"),
      history: historyBefore,
    });
    expectLatestStep({
      step: "warning:disk-space-preflight",
      status: "completed",
      detail: expect.stringContaining("256 MiB available"),
    });
    f.expectPackageInstallSpec("openclaw@9999.0.0");
    expect(f.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("records runtime retention while it runs and settles its outcome", async () => {
    await f.mockPackageInstallAtCaseDir();
    const retention = {
      inventoryMs: 17,
      materializationMs: 23,
      entries: 9,
      estimatedBytes: 36_864,
      linked: 4,
      copied: 1,
    };
    f.retainUpdateRuntime.mockImplementationOnce(async ({ assertCurrent }) => {
      assertCurrent();
      expectLatestStep({
        step: "updater-runtime-retention",
        status: "in_progress",
      });
      return retention;
    });

    await f.updateCommand({ yes: true, json: true });

    expect(f.lastWriteJsonCall()).toMatchObject({
      steps: containingStep({
        name: "updater-runtime-retention",
        exitCode: 0,
        diagnostics: [JSON.stringify(retention)],
      }),
    });
    expectLatestStep({ step: "updater-runtime-retention", status: "completed" });
    expectLatestStep({
      step: "diagnostic:updater-runtime-retention",
      detail: JSON.stringify(retention),
    });
  });

  it("ends unfinished retention at --timeout with the installed package untouched", async () => {
    const packageRoot = await f.mockPackageInstallAtCaseDir();
    const manifest = await fs.readFile(`${packageRoot}/package.json`, "utf8");
    const entered = createDeferredCore<Parameters<RetainUpdateRuntime>[0]>();
    const release = createDeferredCore();
    const leases = createManagedHandoffLeaseStore();
    const sharedArtifacts = ["update-reports", "logs/support"].map(
      (relative) => `${f.profileStateDir()}/${relative}`,
    );
    let retentionSettled = false;
    f.retainUpdateRuntime.mockImplementationOnce(async (options) => {
      options.assertCurrent();
      entered.resolve(options);
      const { signal } = options;
      try {
        await (signal ? withinTest(release.promise, signal) : release.promise);
      } finally {
        retentionSettled = true;
      }
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const work = f
      .updateCommand({ yes: true, json: true, timeout: "60" })
      .catch((error: unknown) => {
        entered.reject(error);
        return error;
      });
    try {
      const { assertCurrent, signal } = await entered.promise;
      assertCurrent();
      const before = f.listUpdateRuns();
      expect(before[0]).toMatchObject({
        status: "running",
        phase: "validating",
        steps: containingStep({ step: "updater-runtime-retention", status: "in_progress" }),
      });
      expect(leases.read(packageRoot)).toMatchObject({ kind: "current", lease: { version: 2 } });
      const sentinelBefore = await readRestartSentinelReadOnly();
      for (const artifact of sharedArtifacts) {
        expect(fsSync.existsSync(artifact)).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(f.lastWriteJsonCall()).toMatchObject({ status: "error" }));
      expect(await work).toMatchObject({ code: 1 });
      expect(retentionSettled).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toMatchObject({ reason: "update-activation-timeout" });
      expect(assertCurrent).toThrow(UpdateActivationTimeoutError);
      expect(f.defaultRuntime.writeJson).toHaveBeenCalledOnce();
      expect(f.lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "update-activation-timeout",
        runId: before[0]?.runId,
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      // The initiating timeout diagnostic precedes the final custody outcome.
      expect(vi.mocked(f.defaultRuntime.error).mock.calls).toEqual([
        [expect.stringContaining("60-second budget")],
        [expect.stringContaining("Update recovery remains pending (update-activation-timeout)")],
      ]);
      await vi.waitFor(() => expect(leases.read(packageRoot)).toEqual({ kind: "absent" }));
      // Cancellation revokes the original writer. A future owner may reconcile
      // this row after driver death; the still-live test driver cannot finish it.
      expect(f.listUpdateRuns()).toEqual(before);
      expect(await readRestartSentinelReadOnly()).toEqual(sentinelBefore);
      for (const artifact of sharedArtifacts) {
        expect(fsSync.existsSync(artifact)).toBe(false);
      }
      expect(await fs.readFile(`${packageRoot}/package.json`, "utf8")).toBe(manifest);
    } finally {
      try {
        release.resolve();
        await work;
        await vi.waitFor(() => expect(leases.read(packageRoot)).toEqual({ kind: "absent" }));
      } finally {
        try {
          await closeOpenClawStateDatabaseAsync();
        } finally {
          vi.useRealTimers();
        }
      }
    }
  });

  it("refuses insufficient initial snapshot capacity before staging", async () => {
    await f.mockPackageInstallAtCaseDir();
    f.initializeExistingUpdateProfile();
    const historyBefore = f.listUpdateRuns();
    const stateDir = await fs.realpath(f.profileStateDir());
    const captureDir = `${stateDir}.update-captures`;
    await fs.mkdir(captureDir);
    vi.stubEnv("TMPDIR", f.makeTempDir("initial-snapshot-temp-"));
    diskSpace(32);
    const allocate = vi.spyOn(fs, "mkdtemp");

    const update = f.updateCommand({ yes: true, json: true });
    await expect(update).rejects.toMatchObject({ code: 1 });

    const record = latestRun();
    const snapshotFailure = expect.objectContaining({
      name: "snapshot-space-preflight",
      exitCode: 1,
      snapshotCapacity: expect.objectContaining({
        pluginBytes: null,
        candidates: containingStep({ availableBytes: 32 * 1024 * 1024 }),
      }),
    });
    expect(f.lastWriteJsonCall()).toMatchObject({
      runId: record?.runId,
      status: "error",
      reason: "snapshot-capacity-insufficient",
      failedStep: snapshotFailure,
      steps: expect.arrayContaining([snapshotFailure]),
    });
    expect(f.packageInstallCommandCall()).toBeUndefined();
    expect(
      allocate.mock.calls.some(
        ([prefix]) =>
          prefix.includes(".openclaw.update-stage-") || prefix.includes("openclaw-update-canary-"),
      ),
    ).toBe(false);
    expect(f.listUpdateRuns()).toEqual([
      expect.objectContaining({
        status: "failed",
        phase: "finished",
        reason: "snapshot-capacity-insufficient",
      }),
      ...historyBefore,
    ]);
    expect(f.getErrorOutput()).toContain("MiB needed");
    expect(f.getErrorOutput()).toContain("32 MiB free");
    expect(f.getErrorOutput()).toContain("Free space on a reported filesystem or set TMPDIR");
    expect(f.getErrorOutput()).toContain("SQLite family");
  });
}
