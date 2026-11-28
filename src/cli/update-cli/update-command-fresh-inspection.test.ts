import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { SqliteReadOnlyInspectionContentionError } from "../../infra/sqlite-readonly-worker-protocol.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import * as channelConfig from "./update-command-config.js";
import * as execution from "./update-command-execution.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as runtimePlan from "./update-command-runtime-preflight.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it("preserves a recovered inspection warning in a fresh preview", async () => {
  const contention = new SqliteReadOnlyInspectionContentionError(
    "SQLite read-only inspection: database is locked",
  );
  vi.spyOn(channelConfig, "readUpdateChannelConfig").mockRejectedValueOnce(contention);
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    ...targetMetadata,
    schemaVersions: { ...targetMetadata.schemaVersions, state: OPENCLAW_STATE_SCHEMA_VERSION },
  });
  vi.spyOn(runtimePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
    ok: true,
    value: {},
  });
  const execute = vi.spyOn(execution, "executeMutableUpdate");

  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  await updateCommand({ yes: true, json: true, restart: false, dryRun: true });

  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      notes: expect.arrayContaining([expect.stringContaining(contention.message)]),
    }),
  );
});
