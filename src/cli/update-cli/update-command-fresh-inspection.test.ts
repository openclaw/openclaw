import fs from "node:fs";
import { assert, expect, it, vi } from "vitest";
import { SqliteReadOnlyInspectionContentionError } from "../../infra/sqlite-readonly-worker-protocol.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import * as channelConfig from "./update-command-config.js";
import * as execution from "./update-command-execution.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it.each([false, true])(
  "preserves a recovered inspection warning through fresh update admission (preview=%s)",
  async (dryRun) => {
    const contention = new SqliteReadOnlyInspectionContentionError(
      "SQLite read-only inspection: database is locked",
    );
    vi.spyOn(channelConfig, "readUpdateChannelConfig").mockRejectedValueOnce(contention);
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      schemaVersions: { ...targetMetadata.schemaVersions, state: OPENCLAW_STATE_SCHEMA_VERSION },
    });
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    let admittedRunId: string | undefined;
    const execute = vi
      .spyOn(execution, "executeMutableUpdate")
      .mockImplementation(async (params) => {
        const run = params.opts.run;
        assert(run);
        admittedRunId = run.runId;
        finishUpdateRun(
          run.runId,
          { status: "skipped", reason: "fixture-before-mutation" },
          { env: run.env },
        );
        return null;
      });

    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    await updateCommand({ yes: true, json: true, restart: false, dryRun });

    if (dryRun) {
      expect(execute).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          notes: expect.arrayContaining([expect.stringContaining(contention.message)]),
        }),
      );
    } else {
      expect(execute).toHaveBeenCalledOnce();
      assert(admittedRunId);
      expect(getUpdateRun(admittedRunId)?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: "warning:installation-inspection",
            status: "completed",
            detail: expect.stringContaining(contention.message),
          }),
        ]),
      );
    }
  },
);
