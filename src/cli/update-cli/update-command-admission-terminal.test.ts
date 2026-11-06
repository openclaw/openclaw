import { expect, it, vi } from "vitest";
import { UPDATE_RUN_DRIVER_LIMIT } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as reconciliation from "../../infra/update-run-reconciliation.js";
import { defaultRuntime } from "../../runtime.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { allowPackageRuntime } from "./update-command-fresh-preview.test-support.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const opts = { yes: true, json: true, restart: false };

it.each(["readable", "unreadable"] as const)(
  "reports the adopted run after admission fails with %s recovery state",
  async (state) => {
    openOpenClawStateDatabase();
    allowPackageRuntime();
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      version: null,
      nodeEngine: null,
      error: "fixture registry unavailable",
    });
    const original = new Error("SQLite source did not stabilize (reason=wal-copy-unstable)");
    let runId: string | undefined;
    let restoreReads: (() => void) | undefined;
    vi.spyOn(reconciliation, "reconcileAbandonedUpdateRunsAsync").mockImplementationOnce(
      async (input, options) => {
        runId = input?.excludeRunId;
        expect(runId).toBeDefined();
        expect(getUpdateRun(runId!, options)).toMatchObject({
          status: "running",
          steps: expect.arrayContaining([expect.objectContaining({ step: "driver:adopted" })]),
        });
        if (state === "unreadable") {
          const read = vi
            .spyOn(stateReads, "withExistingOpenClawStateDatabaseArtifactPreservingReadOnly")
            .mockImplementation(() => {
              throw original;
            });
          restoreReads = () => read.mockRestore();
        }
        throw original;
      },
    );
    const publicationOwners: string[] = [];
    vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
      publicationOwners.push(createManagedHandoffLeaseStore().read(fixture.root).kind);
    });

    await expect(updateCommand(opts)).rejects.toBeDefined();

    expect(runId).toBeDefined();
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "error", runId }),
    );
    if (state === "readable") {
      expect(publicationOwners).toEqual(["absent"]);
    }
    restoreReads?.();
    expect(getUpdateRun(runId!)).toMatchObject({
      status: state === "readable" ? "failed" : "running",
    });
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  },
);

it("does not terminalize an existing run when adoption refuses it", async () => {
  const created = createUpdateRun({
    trigger: "cli",
    origin: {
      driver: {
        host: "current-updater.example",
        pid: 123,
        startIdentity: "1700000000",
      },
      previousDrivers: Array.from({ length: UPDATE_RUN_DRIVER_LIMIT - 1 }, (_, index) => ({
        host: `other-updater-${index}.example`,
        pid: 123,
        startIdentity: "1700000000",
      })),
    },
  });
  const before = getUpdateRun(created.runId);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", created.runId);

  await expect(updateCommand(opts)).rejects.toThrow("too many live or unobservable drivers");

  expect(getUpdateRun(created.runId)).toEqual(before);
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
});
