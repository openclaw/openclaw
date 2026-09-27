import fsSync from "node:fs";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import type { RetainUpdateRuntime } from "../../infra/update-retained-runtime.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";

export function expectPackageSchemaPreflight(
  preflight: Mock<
    typeof import("../../state/openclaw-database-preflight.js").preflightOpenClawDatabaseSchemas
  >,
  stateDir: string,
) {
  expect(preflight).toHaveBeenCalledWith({
    // The updater restores process.env on refusal; inspection retains its scoped marker.
    env: { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    supportedVersions: { state: 3, agent: 9 },
    preserveSourceArtifacts: false,
    configuredAgentDatabaseTargets: [],
    configuredAgentDatabaseCandidatePaths: [
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    ],
  });
}

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
  lastWriteJsonCall: () => unknown;
  expectPackageInstallSpec: (spec: string) => void;
  packageInstallCommandCall: () => [string[], Record<string, unknown>] | undefined;
  defaultRuntime: typeof import("../../runtime.js").defaultRuntime;
  retainUpdateRuntime: Mock<RetainUpdateRuntime>;
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
  lastWriteJsonCall,
  expectPackageInstallSpec,
  packageInstallCommandCall,
  defaultRuntime,
  retainUpdateRuntime,
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
      retainUpdateRuntime.mockImplementationOnce(async ({ assertCurrent, mutationRoots }) => {
        assertCurrent();
        expect(mutationRoots).toEqual([packageRoot]);
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
}
