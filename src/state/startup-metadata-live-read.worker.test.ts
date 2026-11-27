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
  vi.doUnmock("../infra/update-run-recovery-store.js");
  vi.doUnmock("../infra/update-run-reconciliation.read.js");
  vi.resetModules();
});

it("prepares recovery admission without loading reconciliation policy", async () => {
  const loadReconciliation = vi.fn();
  // mock-isolation: Observe first import while preserving the actual reconciliation implementation.
  vi.doMock("../infra/update-run-reconciliation.read.js", async (importOriginal) => {
    loadReconciliation();
    return importOriginal();
  });
  const { prepareUpdateRunAdmissionRead } = await import("../infra/update-run-admission.read.js");
  await prepareUpdateRunAdmissionRead({ type: "updateRuns.recoveryAdmission" });
  expect(loadReconciliation).not.toHaveBeenCalled();
  await prepareUpdateRunAdmissionRead({ type: "updateRuns.reconciliationCandidate", runId: "run" });
  expect(loadReconciliation).toHaveBeenCalledOnce();
});

it("refuses a source replaced while update metadata code loads before opening SQLite", async () => {
  const directory = dirs.make("metadata-import-identity-");
  const pathname = path.join(directory, "state.sqlite");
  fs.writeFileSync(pathname, "original source");
  const identity = readDatabasePathIdentitySync(pathname);
  const entered = createDeferred();
  const resume = createDeferred();
  // mock-isolation: Hold only module preparation; source identity and the metadata handler stay real.
  vi.doMock("../infra/update-run-recovery-store.js", async () => {
    entered.resolve();
    await resume.promise;
    return vi.importActual("../infra/update-run-recovery-store.js");
  });
  const { prepareUpdateRunAdmissionRead } = await import("../infra/update-run-admission.read.js");
  await expect(
    prepareUpdateRunAdmissionRead({ type: "updateRuns.reconciliationCandidates", input: {} }),
  ).resolves.toEqual(expect.any(Function));
  const sqlite = await import("../infra/node-sqlite.js");
  const inspection = await import("../infra/sqlite-readonly-inspection.js");
  const { startupMetadataReadOperations } = await import("./startup-metadata-live-read.worker.js");
  const nativeOpen = vi.spyOn(sqlite, "openNodeSqliteDatabase");
  const liveRead = vi.spyOn(inspection, "tryInspectSqliteReadOnlyInProcess");
  const pending = startupMetadataReadOperations["startupMetadata.readCurrent"](
    { type: "updateRuns.recoveryAdmission" },
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
