import { existsSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readOpenClawStateLease } from "../state/openclaw-state-lease-store.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import type { TranscriptSessionDescriptor } from "../transcripts/provider-types.js";
import { readTranscriptExportOwnership } from "../transcripts/store-sqlite-read.js";
import { transcriptSessionExportKey, TranscriptsStore } from "../transcripts/store.js";
import { observeSettlement } from "./sqlite-readonly.test-support.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import * as workerStore from "./sqlite-worker-store.js";

const dirs = useStateDatabaseTempDirs();

it("retains the export lease while accepted bookkeeping has an unknown settlement", async () => {
  const stateDir = dirs.make("transcript-export-settlement-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), { env });
  const session: TranscriptSessionDescriptor = {
    sessionId: "retained-export",
    startedAt: "2026-09-21T12:00:00.000Z",
    source: { providerId: "manual-transcript" },
  };
  await store.writeSession(session);
  const accepted = createDeferred();
  const settlement = createDeferred<SqliteWorkerOperationSettlement>();
  const original = workerStore.runSqliteWorkerStoreOperation;
  const observer = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation((target, operation, stateContext, assertCurrent, createAdmission) => {
      let exporting = false;
      return original(
        target,
        (scope) =>
          operation({
            execute: async (command, options) => {
              exporting = command.type === "transcripts.markPendingExports";
              const result = await scope.execute(command, options);
              if (exporting) {
                accepted.resolve();
                throw new Error("Accepted export bookkeeping reply was lost");
              }
              return result;
            },
          }),
        stateContext,
        assertCurrent,
        createAdmission &&
          ((retained) =>
            createAdmission(
              exporting
                ? {
                    // Keep the real write and lease owner; replace only its settlement evidence.
                    settled: retained.settled.then(() => settlement.promise),
                  }
                : retained,
            )),
      );
    });
  const result = store.materializeSessionArtifacts(session, "metadata");
  const observed = observeSettlement(result);
  const database = openOpenClawStateDatabase({ env });
  const identity = { scope: "meeting-transcript.export", key: transcriptSessionExportKey(session) };
  try {
    await Promise.race([
      accepted.promise,
      result.then(() => {
        throw new Error("Export ended before its bookkeeping was accepted");
      }),
    ]);
    await setImmediate();
    expect(observed.settled).toBe(false);
    const lease = readOpenClawStateLease(database.db, identity);
    expect(lease).toBeDefined();
    expect(readTranscriptExportOwnership(database.db, session)?.export_pending_json).toBe(
      '["metadata.json"]',
    );
    expect(existsSync(store.sessionDir(session))).toBe(false);

    settlement.resolve({
      kind: "unknown",
      error: new Error("Export bookkeeping settlement is unknown"),
    });
    await expect(result).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(readOpenClawStateLease(database.db, identity)).toEqual(lease);
    expect(existsSync(store.sessionDir(session))).toBe(false);
  } finally {
    settlement.resolve({ kind: "completed" });
    await result.catch(() => {});
    observer.mockRestore();
  }
});
