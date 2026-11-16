import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveUpdateCaptureRoot } from "../../infra/update-capture-paths.js";
import * as backups from "../../infra/update-database-backup.js";
import * as databaseBackup from "../../snapshot/database-backup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureUpdateDatabasesOnline } from "./update-command-database-backup.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import * as managedContext from "./update-command-managed-context.js";

afterEach(() => vi.restoreAllMocks());

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

it("drops the finished stores of a failed online capture and skips the unfinished one", async () => {
  await withOpenClawTestState({ label: "online-capture-failed" }, async (state) => {
    vi.spyOn(managedContext, "readUpdateCandidateSource").mockResolvedValue({
      config: { database: { engine: "postgres", postgres: { recoveryCaptures: "server" } } },
    } as Awaited<ReturnType<typeof managedContext.readUpdateCandidateSource>>);
    let directory = "";
    vi.spyOn(backups, "createUpdateDatabaseBackup").mockImplementation(async (input) => {
      directory = `${input.backupRoot}.databases`;
      fs.mkdirSync(path.join(directory, "a.sqlite.postgres"), { recursive: true });
      fs.mkdirSync(path.join(directory, "b.sqlite.postgres"), { recursive: true });
      fs.writeFileSync(path.join(directory, "b.sqlite.postgres", ".pending"), "");
      throw new Error("connection dropped during the second store");
    });
    // Like the real owner, a capture without a manifest cannot be read.
    const discard = vi
      .spyOn(databaseBackup, "discardPostgresSchemaCaptures")
      .mockImplementation(async (_config, directories) => {
        if (directories.some((entry) => fs.existsSync(path.join(entry, ".pending")))) {
          throw new Error("PostgreSQL export manifest is missing");
        }
      });
    const online = await captureUpdateDatabasesOnline({
      execution: {
        opts: { run: { runId: "00000000-0000-4000-8000-000000000002" } },
        updateInstallKind: "package",
        root: state.stateDir,
        progress: undefined,
      } as unknown as MutableUpdateExecutionParams,
      env: state.env,
      assertCurrent: () => {},
    });
    expect(online).toBeUndefined();
    expect(discard.mock.calls.map(([, directories]) => directories)).toEqual([
      [path.join(directory, "a.sqlite.postgres")],
    ]);
    expect(fs.existsSync(directory)).toBe(false);
    // Package installs keep raw captures under the update-capture root that backups exclude.
    expect(
      directory.startsWith(`${fs.realpathSync(resolveUpdateCaptureRoot(state.stateDir))}/`),
    ).toBe(true);
  });
});
