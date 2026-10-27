import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
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
  currentId,
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
  const run = archiveWorkers.prepareSqliteColdArchiveBatch;
  vi.spyOn(archiveWorkers, "prepareSqliteColdArchiveBatch").mockImplementation(async (...args) => {
    const result = await run(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const worker = vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation");
  return { entered, release, worker };
}

function expectHistoryUnchanged() {
  expect(fixture.snapshot()).toEqual(fixture.original);
  expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
}

function maintain(config = maintenanceConfig(fixture.scope.storePath), assertCurrent?: () => void) {
  return runSessionColdStorageMaintenance({ config, assertCurrent });
}

it.each([
  ["a newly admitted normalized logical key", "protected"],
  ["a newly registered live run", "registry"],
  ["an unrelated newly admitted key", "unrelated"],
  ["revoked configuration", "configuration"],
])("rechecks %s after worker selection without parent SQLite", async (_name, change) => {
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
  const pending = maintain(
    config,
    change === "configuration"
      ? () => {
          if (!config.session.maintenance.coldStorage.enabled) {
            throw new Error("Cold maintenance configuration was revoked");
          }
        }
      : undefined,
  );
  const outcome = pending.catch((error: unknown) => error);
  let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  try {
    await awaitGateBeforeSettlement(
      delayed.entered.promise,
      pending,
      "Cold selection was not dispatched",
    );
    if (change === "configuration") {
      config.session.maintenance.coldStorage.enabled = false;
    } else if (change === "registry") {
      registerAgentRunContext("cold-live-run", {
        agentId: "main",
        sessionKey: fixture.scope.sessionKey,
        projectSessionActive: true,
      });
    } else {
      admission = await beginSessionEffect({
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
    clearAgentRunContext("cold-live-run");
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

it.each([
  "registry",
  "recovery-cycle",
  "recovery-run",
  "recovery-tombstone",
  "terminal-run",
] as const)(
  "keeps pending %s custody hot before recovery dispatch, then permits retired claims",
  async (custody) => {
    const protectedHistory = custody !== "recovery-tombstone" && custody !== "terminal-run";
    if (custody === "registry") {
      registerAgentRunContext("cold-live-run", {
        agentId: "main",
        sessionKey: fixture.scope.sessionKey,
        projectSessionActive: true,
      });
    } else {
      replaceSessionEntrySync(fixture.scope, {
        sessionId: currentId,
        updatedAt: 1,
        ...(custody === "recovery-cycle" || custody === "recovery-tombstone"
          ? {
              mainRestartRecovery: {
                cycleId: "waiting",
                revision: 1,
                chargedAttempts: 0,
                ...(custody === "recovery-tombstone" ? { tombstone: { reason: "exhausted" } } : {}),
              },
            }
          : {
              restartRecoveryRuns: [
                { runId: "awaiting-recovery", lifecycleGeneration: "previous-gateway" },
              ],
              ...(custody === "terminal-run"
                ? { restartRecoveryTerminalRunIds: ["awaiting-recovery"] }
                : {}),
            }),
      });
    }
    const before = fixture.snapshot();
    try {
      await expect(maintain()).resolves.toEqual({
        archivedTranscripts: protectedHistory ? 0 : 1,
        externalizedTranscripts: 0,
      });
      if (protectedHistory) {
        expect(fixture.snapshot()).toEqual(before);
        expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
      }
    } finally {
      clearAgentRunContext("cold-live-run");
    }
  },
);

it("propagates selection failure without a mutation or synchronous fallback", async () => {
  const failure = new Error("Cold selection worker refused");
  const worker = vi
    .spyOn(archiveWorkers, "prepareSqliteColdArchiveBatch")
    .mockRejectedValueOnce(failure);
  const observer = observeParentSqlite();
  try {
    await expect(maintain()).rejects.toBe(failure);
    expect(observer.counts).toEqual(emptySqliteCounts());
    expect(worker).toHaveBeenCalledOnce();
  } finally {
    observer.restore();
  }
  expectHistoryUnchanged();
});

it("retains an embedded archive when its window gains an admitted owner after preparation", async () => {
  const config = maintenanceConfig(fixture.scope.storePath);
  await expect(maintain(config)).resolves.toEqual({
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
  const pending = maintain(config);
  const outcome = pending.catch((error: unknown) => error);
  let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
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
    admission = await beginSessionEffect({
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
