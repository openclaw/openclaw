import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { prepareSessionColdRestoreInWorker } from "../config/sessions/session-cold-storage-worker.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readUpdateCandidateStateInventoryInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";
import { createStateSnapshotInput } from "./update-candidate-state.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it("rehearses file-backed cold transcripts without the source archive directory", async () => {
  const root = dirs.make("candidate-cold-archives-");
  const stateDir = path.join(root, "source");
  const targetStateDir = path.join(root, "rehearsal");
  const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
  const source = path.join(stateDir, relative);
  const fixture = await createSessionColdStorageFixture(source);
  await expect(
    runSessionColdStorageMaintenance({ config: maintenanceConfig(source) }),
  ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  const descriptor = readSessionColdTranscript(fixture.database(), historicalId);
  expect(descriptor?.storage).toBe("file");
  await closeOpenClawAgentDatabasesAsync();
  await fs.mkdir(targetStateDir);
  const input = createStateSnapshotInput(root, stateDir, targetStateDir);
  const inventory = await readUpdateCandidateStateInventoryInProcess(input);
  await snapshotUpdateCandidateState({
    ...input,
    pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
    databaseInventory: [...inventory.databases.keys()],
  });
  const original = await fs.readFile(source);
  // Rehearsal Doctor resolves archives beside its copied store, never the live state directory.
  const archive = resolveSessionColdArchivePath(source, descriptor!.archive_name);
  await fs.rename(archive, `${archive}.moved`);

  const target = path.join(targetStateDir, relative);
  const copied = (() => {
    using db = openNodeSqliteDatabase(target, { readOnly: true });
    return readSessionColdTranscript(db, historicalId);
  })();
  await expect(
    prepareSessionColdRestoreInWorker({
      kind: "cold-restore",
      databaseOptions: { agentId: "main", path: target },
      sessionId: historicalId,
      archive: copied!,
    }),
  ).resolves.toBeDefined();
  expect(await fs.readFile(source)).toEqual(original);
});
