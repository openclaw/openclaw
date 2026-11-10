import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as candidateState from "../../infra/update-candidate-state.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import { readUpdateDatabaseGenerations } from "../../infra/update-database-generations.js";
import { resolveUpdateSqlitePath } from "../../infra/update-database-path.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../../infra/update-doctor-result.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  observeUpdateParentDatabaseWrites,
  recordUpdateDatabaseWrites,
} from "./update-command-database-receipts.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

// A real, closed ledger whose next generation read meets a connection that has
// only begun building its WAL index: the index file exists but has no header yet.
async function ledgerBeingOpened() {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(dirs.make("update-ledger-read-")) };
  openOpenClawStateDatabase({ env });
  await closeOpenClawStateDatabaseAsync();
  const key = resolveUpdateSqlitePath(resolveOpenClawStateSqlitePath(env));
  const backup: UpdateDatabaseBackup = {
    directory: env.OPENCLAW_STATE_DIR,
    databases: [],
    missingPaths: [],
    sourcePaths: [key],
    sourceGenerations: readUpdateDatabaseGenerations([key]),
    warnings: [],
  };
  fs.writeFileSync(`${key}-shm`, Buffer.alloc(16));
  return { env, key, backup };
}

it("keeps the update going without restoration when the ledger generation cannot be read", async () => {
  const { env, key, backup } = await ledgerBeingOpened();
  const sourceGenerations = { ...backup.sourceGenerations };

  await observeUpdateParentDatabaseWrites(backup, { env });

  expect(backup.restoreRefusal).toMatch(
    /^update ledger database generation could not be observed: .*WAL commit header is unavailable or changing/,
  );
  expect(backup.migration).toBeUndefined();
  // Doctor admits from the generations the parent hands it once the opener finishes.
  fs.rmSync(`${key}-shm`);
  const warnings: string[] = [];
  const doctor = createUpdateDoctorDatabaseWriteCapture(
    backup.migration?.to ?? backup.sourceGenerations,
    { env, signal: new AbortController().signal, warn: (message) => warnings.push(message) },
  )!;
  await doctor.admit();
  await doctor.settle();
  expect(warnings).toEqual([]);
  expect(doctor.receipt).toMatchObject({ unchanged: true, generations: sourceGenerations });
  // A clean Doctor receipt cannot restore authority the ledger read already withdrew.
  const step = recordUpdateDatabaseWrites(backup, doctor.receipt, { name: "post-update doctor" });
  expect(step.warnings?.[0]).toMatch(
    /^Automatic database restoration unavailable: update ledger database generation could not be observed: /,
  );
  expect(backup.migration).toBeUndefined();
  expect(backup.sourceGenerations).toEqual(sourceGenerations);
});

it("records the ledger's post-close generation when the read succeeds", async () => {
  const { env, key, backup } = await ledgerBeingOpened();
  fs.rmSync(`${key}-shm`);
  await observeUpdateParentDatabaseWrites(backup, { env });
  expect(backup.restoreRefusal).toBeUndefined();
  expect(backup.migration).toEqual({
    name: "update ledger writes",
    backup: backup.directory,
    from: backup.sourceGenerations,
    to: readUpdateDatabaseGenerations([key]),
  });
});

it.each(["before", "after"] as const)(
  "propagates a fence lost %s the failed ledger read",
  async (timing) => {
    const { env, backup } = await ledgerBeingOpened();
    const fence = new Error("update requester revoked");
    let calls = 0;
    const read = vi.spyOn(candidateState, "readUpdateDatabaseGenerationsIsolated");
    await expect(
      observeUpdateParentDatabaseWrites(backup, {
        env,
        assertCurrent: () => {
          calls += 1;
          if (timing === "before" || calls > 1) {
            throw fence;
          }
        },
      }),
    ).rejects.toBe(fence);
    expect(read).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
    expect(backup.migration).toBeUndefined();
  },
);

it("propagates uncertain cleanup from the ledger read", async () => {
  const { env, backup } = await ledgerBeingOpened();
  const cleanup = new CommandProcessCleanupError();
  vi.spyOn(candidateState, "readUpdateDatabaseGenerationsIsolated").mockRejectedValue(cleanup);
  await expect(observeUpdateParentDatabaseWrites(backup, { env })).rejects.toBe(cleanup);
  expect(backup.restoreRefusal).toMatch(
    /^update ledger database generation could not be observed: /,
  );
  expect(backup.migration).toBeUndefined();
});
