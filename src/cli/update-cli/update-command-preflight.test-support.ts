import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import type { RetainUpdateRuntime } from "../../infra/update-retained-runtime.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";

type UpdatePreflightFixture = {
  mockPackageInstallAtCaseDir: () => Promise<string>;
  mockCurrentProcessFreshDoctor: () => void;
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
  mockCurrentProcessFreshDoctor,
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
  it("records low disk space before target lookup and still runs package updates", async () => {
    await mockPackageInstallAtCaseDir();
    mockCurrentProcessFreshDoctor();
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(
      statfsFixture({
        bavail: 256,
        bsize: 1024 * 1024,
      }),
    );
    const targetLookups: Array<{ output: string; steps: UpdateRunRecord["steps"] }> = [];
    const resolveTag = vi.mocked(resolveNpmChannelTag).getMockImplementation()!;
    vi.mocked(resolveNpmChannelTag).mockImplementation(async (...args) => {
      targetLookups.push({
        output: getLogOutput(),
        steps: listUpdateRuns({ limit: 1 })[0]?.steps ?? [],
      });
      return await resolveTag(...args);
    });

    await updateCommand({ yes: true });

    expect(targetLookups).toContainEqual({
      output: expect.stringContaining("Low disk space near"),
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "warning:disk-space-preflight",
          status: "completed",
          detail: expect.stringContaining("256 MiB available"),
        }),
      ]),
    });
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

  it.each(["retained", "skipped", "failed"] as const)(
    "records runtime retention while it runs and settles its outcome (%s)",
    async (outcome) => {
      const failed = outcome === "failed";
      const packageRoot = await mockPackageInstallAtCaseDir();
      mockCurrentProcessFreshDoctor();
      const retention = {
        inventoryMs: 17,
        materializationMs: 23,
        entries: 9,
        estimatedBytes: 36_864,
        linked: 4,
        copied: 1,
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
        if (failed) {
          throw new Error("The updater runtime could not be retained");
        }
        return outcome === "retained" ? retention : undefined;
      });

      const update = updateCommand({ yes: true, json: true });
      if (failed) {
        await expect(update).rejects.toMatchObject({ code: 1 });
        expect(JSON.stringify(lastWriteJsonCall())).toContain(
          "The updater runtime could not be retained",
        );
      } else {
        await update;
      }

      expect(retainUpdateRuntime).toHaveBeenCalledOnce();
      expect(
        listUpdateRuns({ limit: 1 })[0]?.steps.filter(
          (step) => step.step === "updater-runtime-retention",
        ),
      ).toEqual([
        expect.objectContaining({
          status: failed ? "failed" : "completed",
          ...(failed
            ? { exitCode: 1, detail: expect.stringContaining("could not be retained") }
            : { endedAtMs: expect.any(Number) }),
        }),
      ]);
      expect(
        listUpdateRuns({ limit: 1 })[0]
          ?.steps.filter((step) => step.step === "diagnostic:updater-runtime-retention")
          .map((step) => JSON.parse(step.detail!)),
      ).toEqual(outcome === "retained" ? [retention] : []);
    },
  );

  it.each(["insufficient", "alternative", "unknown", "plenty", "package-only"] as const)(
    "checks initial snapshot capacity before staging (%s)",
    async (scenario) => {
      const pkgRoot = await mockPackageInstallAtCaseDir();
      initializeExistingUpdateProfile();
      const stateDir = await fs.realpath(profileStateDir());
      const captureDir = `${stateDir}.update-captures`;
      await fs.mkdir(captureDir);
      vi.stubEnv("TMPDIR", makeTempDir("initial-snapshot-temp-"));
      vi.spyOn(fsSync, "statfsSync").mockImplementation((checkedPath) => {
        if (scenario === "unknown") {
          throw new Error("capacity unavailable");
        }
        const location = String(checkedPath);
        const low =
          scenario === "insufficient" ||
          (scenario === "alternative" && location !== captureDir) ||
          (scenario === "package-only" && location === path.dirname(pkgRoot));
        return statfsFixture({ bavail: low ? 32 : 2048, bsize: 1024 * 1024 });
      });
      const allocate = vi.spyOn(fs, "mkdtemp");

      const update = updateCommand({ yes: true, json: true });
      if (scenario === "insufficient") {
        await expect(update).rejects.toMatchObject({ code: 1 });
      } else {
        await update;
      }

      const record = listUpdateRuns({ limit: 1 })[0];
      if (scenario === "insufficient") {
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "snapshot-capacity-insufficient",
        });
        expect(packageInstallCommandCall()).toBeUndefined();
        expect(
          allocate.mock.calls.some(
            ([prefix]) =>
              prefix.includes(".openclaw.update-stage-") ||
              prefix.includes("openclaw-update-canary-"),
          ),
        ).toBe(false);
        expect(record).toMatchObject({
          status: "failed",
          reason: "snapshot-capacity-insufficient",
        });
        expect(record?.steps).toContainEqual(
          expect.objectContaining({
            step: "snapshot-space-preflight",
            status: "failed",
            snapshotCapacity: expect.objectContaining({
              pluginBytes: null,
              candidates: expect.arrayContaining([
                expect.objectContaining({ availableBytes: 32 * 1024 * 1024 }),
              ]),
            }),
          }),
        );
        expect(getErrorOutput()).toContain("MiB needed");
        expect(getErrorOutput()).toContain("32 MiB free");
        expect(getErrorOutput()).toContain("Free space on a reported filesystem or set TMPDIR");
        expect(getErrorOutput()).toContain("SQLite family");
      } else {
        expectPackageInstallSpec("openclaw@9999.0.0");
        expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
        expect(
          record?.steps.filter((step) => step.step.startsWith("warning:snapshot-space-preflight")),
        ).toEqual([]);
        expect(record?.steps.map(({ detail }) => detail).join("\n")).toContain("SQLite family");
        expect(record?.steps.map(({ detail }) => detail).join("\n")).toContain("openclaw.sqlite");
        expect(getErrorOutput()).not.toContain("SQLite family");
        expect(getErrorOutput()).not.toContain("Snapshot capacity estimate incomplete");
      }
    },
  );
}
