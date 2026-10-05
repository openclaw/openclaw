import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";

let state: OpenClawTestState;
let fixture: Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
let seedPath: string;
let aliasStorePath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  fixture = await createSessionColdStorageFixture(state.statePath("selection.sqlite"));
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  seedPath = state.statePath("selection-seed.sqlite");
  await fs.copyFile(fixture.scope.storePath, seedPath);
  aliasStorePath = state.statePath("alias", "selection.sqlite");
  if (process.platform === "win32") {
    await fs.symlink(state.stateDir, state.statePath("alias"), "junction");
  } else {
    await fs.mkdir(state.statePath("alias"));
    await fs.symlink(fixture.scope.storePath, aliasStorePath, "file");
  }
});
beforeEach(async () => {
  await fs.copyFile(seedPath, fixture.scope.storePath);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});
afterAll(async () => {
  await state.cleanup();
});

function delayPreparation() {
  const entered = createDeferred();
  const release = createDeferred();
  const run = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
  const worker = vi
    .spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation")
    .mockImplementation(async (params) => {
      const result = await run(params);
      if (
        params.expectedMessageType === "done" &&
        "operation" in params.workerData &&
        params.workerData.operation === "cold-prepare"
      ) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
  return { entered, release, worker };
}

function expectHistoryUnchanged() {
  expect(fixture.snapshot()).toEqual(fixture.original);
  expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
}

it.each([
  { name: "a newly admitted normalized logical key", change: "protected" },
  { name: "an unrelated newly admitted key", change: "unrelated" },
  { name: "revoked configuration", change: "configuration" },
])("rechecks $name after worker selection without parent SQLite", async ({ change }) => {
  const protectsHistory = change !== "unrelated";
  const ownerStorePath =
    change === "configuration"
      ? fixture.scope.storePath
      : protectsHistory
        ? state.statePath("selection.json")
        : aliasStorePath;
  const delayed = delayPreparation();
  const observer = observeParentSqlite();
  const config = maintenanceConfig(ownerStorePath);
  const pending = runSessionColdStorageMaintenance({
    config,
    assertCurrent:
      change === "configuration"
        ? () => {
            if (!config.session.maintenance.coldStorage.enabled) {
              throw new Error("Cold maintenance configuration was revoked");
            }
          }
        : undefined,
  });
  const outcome = pending.catch((error: unknown) => error);
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  try {
    await awaitGateBeforeSettlement(
      delayed.entered.promise,
      pending,
      "Cold selection was not dispatched",
    );
    if (change === "configuration") {
      config.session.maintenance.coldStorage.enabled = false;
    } else {
      admission = await beginSessionWorkAdmission({
        scope: ownerStorePath,
        identities: [
          protectsHistory ? fixture.scope.sessionKey.toUpperCase() : "agent:main:unrelated-work",
        ],
        assertAllowed: () => {},
      });
    }
    delayed.release.resolve();
    if (protectsHistory) {
      await expect(pending).rejects.toThrow(
        change === "configuration"
          ? "Cold maintenance configuration was revoked"
          : "Transcript became active",
      );
      expect(
        delayed.worker.mock.calls.some(([params]) => params.expectedMessageType === "reclaimed"),
      ).toBe(false);
    } else {
      await expect(pending).resolves.toEqual({
        archivedTranscripts: 1,
        externalizedTranscripts: 0,
      });
    }
    expect(observer.counts).toEqual(emptySqliteCounts());
  } finally {
    delayed.release.resolve();
    await outcome;
    observer.restore();
    admission?.release();
    await admission?.released;
  }
  if (protectsHistory) {
    expectHistoryUnchanged();
  } else {
    const archive = readSessionColdTranscript(fixture.database(), historicalId)!;
    expect(
      (await fs.stat(resolveSessionColdArchivePath(ownerStorePath, archive.archive_name))).size,
    ).toBe(archive.archive_bytes);
  }
});

it("propagates selection failure without a mutation or synchronous fallback", async () => {
  const failure = new Error("Cold selection worker refused");
  const worker = vi
    .spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation")
    .mockRejectedValueOnce(failure);
  const observer = observeParentSqlite();
  try {
    await expect(
      runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) }),
    ).rejects.toBe(failure);
    expect(observer.counts).toEqual(emptySqliteCounts());
    expect(worker).toHaveBeenCalledOnce();
  } finally {
    observer.restore();
  }
  expectHistoryUnchanged();
});

it("retains an embedded archive when its window gains an admitted owner after preparation", async () => {
  const config = maintenanceConfig(fixture.scope.storePath);
  await expect(runSessionColdStorageMaintenance({ config })).resolves.toEqual({
    archivedTranscripts: 1,
    externalizedTranscripts: 0,
  });
  const archive = readSessionColdTranscript(fixture.database(), historicalId)!;
  const bytes = await fs.readFile(
    resolveSessionColdArchivePath(fixture.scope.storePath, archive.archive_name),
  );
  const reboundKey = "agent:main:rebound-cold-owner";
  const reboundScope = {
    ...fixture.scope,
    sessionKey: reboundKey,
    sessionId: "rebound-cold-current",
  };
  replaceSessionEntrySync(reboundScope, { sessionId: reboundScope.sessionId, updatedAt: 1 });
  fixture
    .database()
    .prepare(
      "UPDATE session_transcript_cold_archives SET storage = 'sqlite', archive_blob = ? WHERE session_id = ?",
    )
    .run(bytes, historicalId);
  await closeOpenClawAgentDatabasesAsync();

  const delayed = delayPreparation();
  const pending = runSessionColdStorageMaintenance({ config });
  const outcome = pending.catch((error: unknown) => error);
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  try {
    await awaitGateBeforeSettlement(
      delayed.entered.promise,
      pending,
      "Cold externalization was not prepared",
    );
    fixture
      .database()
      .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
      .run(reboundKey, historicalId);
    const before = fixture.snapshot();
    admission = await beginSessionWorkAdmission({
      scope: fixture.scope.storePath,
      identities: [reboundKey],
      assertAllowed: () => {},
    });
    delayed.release.resolve();
    await expect(pending).rejects.toThrow("Transcript ownership changed");
    expect(fixture.snapshot()).toEqual(before);
    expect(
      fixture
        .database()
        .prepare(
          "SELECT storage, archive_blob FROM session_transcript_cold_archives WHERE session_id = ?",
        )
        .get(historicalId),
    ).toEqual({ storage: "sqlite", archive_blob: new Uint8Array(bytes) });
  } finally {
    delayed.release.resolve();
    await outcome;
    admission?.release();
    await admission?.released;
  }
});
