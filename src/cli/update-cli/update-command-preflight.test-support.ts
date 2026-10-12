import fsSync from "node:fs";
import fs from "node:fs/promises";
import { expect, it, vi, type Mock } from "vitest";
import type { RetainUpdateRuntime } from "../../infra/update-retained-runtime.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";

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

export function registerUpdatePreflightTests({
  mockPackageInstallAtCaseDir,
  statfsFixture,
  resolveNpmChannelTag,
  fetchNpmPackageTargetStatus,
  listUpdateRuns,
  updateCommand,
  getLogOutput,
  getErrorOutput,
  lastWriteJsonCall,
  expectPackageInstallSpec,
  packageInstallCommandCall,
  defaultRuntime,
  retainUpdateRuntime,
  initializeExistingUpdateProfile,
  profileStateDir,
  makeTempDir,
}: UpdatePreflightFixture) {
  it("reports low disk space before target lookup and persists it after admission", async () => {
    await mockPackageInstallAtCaseDir();
    const historyBefore = listUpdateRuns();
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(
      statfsFixture({
        bavail: 256,
        bsize: 1024 * 1024,
      }),
    );
    const targetLookups: Array<{ output: string; history: UpdateRunRecord[] }> = [];
    const resolveTag = vi.mocked(resolveNpmChannelTag).getMockImplementation()!;
    vi.mocked(resolveNpmChannelTag).mockImplementation(async (...args) => {
      targetLookups.push({
        output: getLogOutput(),
        history: listUpdateRuns(),
      });
      return await resolveTag(...args);
    });

    await updateCommand({ yes: true });

    expect(targetLookups).toContainEqual({
      output: expect.stringContaining("Low disk space near"),
      history: historyBefore,
    });
    expect(listUpdateRuns({ limit: 1 })[0]?.steps).toContainEqual(
      expect.objectContaining({
        step: "warning:disk-space-preflight",
        status: "completed",
        detail: expect.stringContaining("256 MiB available"),
      }),
    );
    expectPackageInstallSpec("openclaw@9999.0.0");
    const preflightParams = vi
      .mocked(fetchNpmPackageTargetStatus)
      .mock.calls.find(([params]) => params.target === "9999.0.0")?.[0];
    expect(preflightParams).toEqual(
      expect.objectContaining({
        target: "9999.0.0",
        spec: "openclaw@9999.0.0",
        cwd: process.cwd(),
      }),
    );
    expect(packageInstallCommandCall()?.[1].env).toBe(preflightParams?.env);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("records runtime retention while it runs and settles its outcome", async () => {
    const packageRoot = await mockPackageInstallAtCaseDir();
    const retention = {
      inventoryMs: 17,
      materializationMs: 23,
      entries: 9,
      estimatedBytes: 36_864,
      linked: 4,
      copied: 1,
      retainedImports: true,
    };
    retainUpdateRuntime.mockImplementationOnce(async ({ assertCurrent, installTarget }) => {
      assertCurrent();
      expect(installTarget).toMatchObject({ manager: "npm", packageRoot });
      expect(listUpdateRuns({ limit: 1 })[0]?.steps).toContainEqual(
        expect.objectContaining({
          step: "updater-runtime-retention",
          status: "in_progress",
          startedAtMs: expect.any(Number),
        }),
      );
      return retention;
    });

    await updateCommand({ yes: true, json: true });

    expect(retainUpdateRuntime).toHaveBeenCalledOnce();
    expect(lastWriteJsonCall()).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          name: "updater-runtime-retention",
          command: "retain running updater runtime",
          cwd: packageRoot,
          durationMs: expect.any(Number),
          exitCode: 0,
          diagnostics: [JSON.stringify(retention)],
        }),
      ]),
    });
    expect(
      listUpdateRuns({ limit: 1 })[0]?.steps.filter(
        (step) => step.step === "updater-runtime-retention",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "completed",
        endedAtMs: expect.any(Number),
      }),
    ]);
    expect(
      listUpdateRuns({ limit: 1 })[0]
        ?.steps.filter((step) => step.step === "diagnostic:updater-runtime-retention")
        .map((step) => JSON.parse(step.detail!)),
    ).toEqual([retention]);
  });

  it("refuses insufficient initial snapshot capacity before staging", async () => {
    await mockPackageInstallAtCaseDir();
    initializeExistingUpdateProfile();
    const historyBefore = listUpdateRuns();
    const stateDir = await fs.realpath(profileStateDir());
    const captureDir = `${stateDir}.update-captures`;
    await fs.mkdir(captureDir);
    vi.stubEnv("TMPDIR", makeTempDir("initial-snapshot-temp-"));
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(
      statfsFixture({ bavail: 32, bsize: 1024 * 1024 }),
    );
    const allocate = vi.spyOn(fs, "mkdtemp");

    const update = updateCommand({ yes: true, json: true });
    await expect(update).rejects.toMatchObject({ code: 1 });

    const record = listUpdateRuns({ limit: 1 })[0];
    const snapshotFailure = expect.objectContaining({
      name: "snapshot-space-preflight",
      exitCode: 1,
      snapshotCapacity: expect.objectContaining({
        pluginBytes: null,
        candidates: expect.arrayContaining([
          expect.objectContaining({ availableBytes: 32 * 1024 * 1024 }),
        ]),
      }),
    });
    expect(lastWriteJsonCall()).toMatchObject({
      runId: record?.runId,
      status: "error",
      reason: "snapshot-capacity-insufficient",
      failedStep: snapshotFailure,
      steps: expect.arrayContaining([snapshotFailure]),
    });
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(
      allocate.mock.calls.some(
        ([prefix]) =>
          prefix.includes(".openclaw.update-stage-") || prefix.includes("openclaw-update-canary-"),
      ),
    ).toBe(false);
    expect(listUpdateRuns()).toEqual([
      expect.objectContaining({
        status: "failed",
        phase: "finished",
        reason: "snapshot-capacity-insufficient",
      }),
      ...historyBefore,
    ]);
    expect(getErrorOutput()).toContain("MiB needed");
    expect(getErrorOutput()).toContain("32 MiB free");
    expect(getErrorOutput()).toContain("Free space on a reported filesystem or set TMPDIR");
    expect(getErrorOutput()).toContain("SQLite family");
  });
}
