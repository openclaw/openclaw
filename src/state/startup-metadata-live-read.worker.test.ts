import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.doUnmock("../infra/update-run-reconciliation.read.js");
  vi.doUnmock("../infra/restart-stale-pids.js");
  vi.resetModules();
});

it("refuses a source replaced while update metadata code loads before opening SQLite", async () => {
  const directory = dirs.make("metadata-import-identity-");
  const pathname = path.join(directory, "state.sqlite");
  fs.writeFileSync(pathname, "original source");
  const identity = readDatabasePathIdentitySync(pathname);
  const entered = createDeferred();
  const resume = createDeferred();
  // mock-isolation: Hold only module preparation; source identity and the metadata handler stay real.
  vi.doMock("../infra/update-run-reconciliation.read.js", async () => {
    entered.resolve();
    await resume.promise;
    return vi.importActual("../infra/update-run-reconciliation.read.js");
  });
  const sqlite = await import("../infra/node-sqlite.js");
  const inspection = await import("../infra/sqlite-readonly-inspection.js");
  const { startupMetadataReadOperations } = await import("./startup-metadata-live-read.worker.js");
  const nativeOpen = vi.spyOn(sqlite, "openNodeSqliteDatabase");
  const liveRead = vi.spyOn(inspection, "tryInspectSqliteReadOnlyInProcess");
  const pending = startupMetadataReadOperations["startupMetadata.readCurrent"](
    { type: "updateRuns.reconciliationCandidates", input: {} },
    {
      path: pathname,
      env: {},
      assertCurrent: () => assertExistingDatabaseIdentity(pathname, identity.key),
    },
  );
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "Metadata read finished before import",
    );
    expect(nativeOpen).not.toHaveBeenCalled();
    fs.renameSync(pathname, `${pathname}.original`);
    fs.writeFileSync(pathname, "replacement source");
    resume.resolve();
    await expect(pending).rejects.toThrow("SQLite database file identity changed");
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(liveRead).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory).toSorted()).toEqual(["state.sqlite", "state.sqlite.original"]);
  } finally {
    resume.resolve();
    await pending.catch(() => {});
  }
});

it("selects reconciliation candidates without loading Gateway process cleanup", async () => {
  // mock-isolation: Fail on import to catch Gateway process cleanup loading in the SQLite reader.
  vi.doMock("../infra/restart-stale-pids.js", () => {
    throw new Error("Gateway process cleanup loaded during update reconciliation");
  });
  const { openNodeSqliteDatabase } = await import("../infra/node-sqlite.js");
  const { prepareUpdateRunAdmissionRead } = await import("../infra/update-run-admission.read.js");
  const command = { type: "updateRuns.reconciliationCandidates", input: {} } as const;
  const read = await prepareUpdateRunAdmissionRead(command);
  using database = openNodeSqliteDatabase(":memory:");
  expect(read(database)).toEqual({ type: command.type, candidates: [] });
});
