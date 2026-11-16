import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as backups from "../../infra/update-database-backup.js";
import * as databaseBackup from "../../snapshot/database-backup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureUpdateDatabasesOnline } from "./update-command-database-backup.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import * as managedContext from "./update-command-managed-context.js";

it("drops the online capture when the run is cancelled as the capture finishes", async () => {
  await withOpenClawTestState({ label: "online-capture-abort" }, async (state) => {
    const root = fs.mkdtempSync(path.join(state.stateDir, "install-"));
    vi.spyOn(managedContext, "readUpdateCandidateSource").mockResolvedValue({
      config: { database: { engine: "postgres", postgres: { recoveryCaptures: "server" } } },
    } as Awaited<ReturnType<typeof managedContext.readUpdateCandidateSource>>);
    let exportDirectory = "";
    vi.spyOn(backups, "createUpdateDatabaseBackup").mockImplementation(async (input) => {
      const directory = `${input.backupRoot}.databases`;
      exportDirectory = path.join(directory, "agent.sqlite.postgres");
      fs.mkdirSync(exportDirectory, { recursive: true });
      return {
        directory,
        databases: [
          {
            path: "/state/agent.sqlite",
            snapshotPath: path.join(directory, "agent.sqlite"),
            userVersion: 1,
            sha256: "0".repeat(64),
            sizeBytes: 1,
            engine: "postgres",
            exportDirectory,
          },
        ],
        missingPaths: [],
        sourcePaths: [],
        sourceGenerations: {},
        warnings: [],
      };
    });
    const discard = vi.spyOn(databaseBackup, "discardPostgresSchemaCaptures").mockResolvedValue();
    let checks = 0;
    const cancelled = new Error("run cancelled");
    const capture = captureUpdateDatabasesOnline({
      execution: {
        opts: { run: { runId: "00000000-0000-4000-8000-000000000001" } },
        updateInstallKind: "git",
        root,
        progress: undefined,
      } as unknown as MutableUpdateExecutionParams,
      env: state.env,
      // The deadline expires while the capture runs; the next check after it throws.
      assertCurrent: () => {
        if (++checks > 1) {
          throw cancelled;
        }
      },
    });
    await expect(capture).rejects.toBe(cancelled);
    expect(discard).toHaveBeenCalledWith(expect.anything(), [exportDirectory]);
    expect(fs.existsSync(path.dirname(exportDirectory))).toBe(false);
  });
});
