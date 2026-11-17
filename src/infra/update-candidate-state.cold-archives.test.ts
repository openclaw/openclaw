import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetSessionStore } from "../config/sessions/session-accessor.sqlite-reset.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import {
  mutateSessionColdTranscriptInWorker,
  prepareSessionColdRestoreInWorker,
} from "../config/sessions/session-cold-storage-worker.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { linkRehearsalColdArchives } from "./update-candidate-cold-archives.js";
import {
  readUpdateCandidateStateInventoryInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";
import { createStateSnapshotInput } from "./update-candidate-state.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");

async function snapshotWithFileArchive() {
  const root = dirs.make("candidate-cold-archives-");
  const stateDir = path.join(root, "source");
  const targetStateDir = path.join(root, "rehearsal");
  const source = path.join(stateDir, relative);
  const fixture = await createSessionColdStorageFixture(source);
  await expect(
    runSessionColdStorageMaintenance({ config: maintenanceConfig(source) }),
  ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  const archived = readSessionColdTranscript(fixture.database(), historicalId);
  expect(archived?.storage).toBe("file");
  await closeOpenClawAgentDatabasesAsync();
  await fs.mkdir(targetStateDir);
  const input = createStateSnapshotInput(root, stateDir, targetStateDir);
  const inventory = await readUpdateCandidateStateInventoryInProcess(input);
  await snapshotUpdateCandidateState({
    ...input,
    pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
    databaseInventory: [...inventory.databases.keys()],
  });
  const target = path.join(targetStateDir, relative);
  const copied = (() => {
    using db = openNodeSqliteDatabase(target, { readOnly: true });
    return readSessionColdTranscript(db, historicalId)!;
  })();
  return { source, target, copied, archive: archived!.archive_name };
}

function restoreFromRehearsal(
  target: string,
  copied: NonNullable<ReturnType<typeof readSessionColdTranscript>>,
) {
  return prepareSessionColdRestoreInWorker({
    kind: "cold-restore",
    databaseOptions: { agentId: "main", path: target },
    sessionId: historicalId,
    archive: copied,
  });
}

it("rehearses file-backed cold transcripts without the source archive directory", async () => {
  const { source, target, copied, archive } = await snapshotWithFileArchive();
  const original = await fs.readFile(source);
  // Rehearsal Doctor resolves archives beside its copied store, never the live state directory.
  const file = resolveSessionColdArchivePath(source, archive);
  await fs.rename(file, `${file}.moved`);

  expect(copied.storage).toBe("file");
  await expect(restoreFromRehearsal(target, copied)).resolves.toBeDefined();
  expect(await fs.readFile(source)).toEqual(original);
});

it("runs rehearsal archive steps on a linked archive without changing the live file", async () => {
  const { source, target, copied, archive } = await snapshotWithFileArchive();
  const live = resolveSessionColdArchivePath(source, archive);
  const rehearsal = resolveSessionColdArchivePath(target, archive);
  const bytes = await fs.readFile(live);
  const before = await fs.stat(live);
  expect((await fs.stat(rehearsal)).ino).toBe(before.ino);

  const plan = {
    kind: "cold-restore" as const,
    databaseOptions: { agentId: "main", path: target },
    sessionId: historicalId,
    archive: copied,
  };
  const records = await prepareSessionColdRestoreInWorker(plan);
  expect(mutateSessionColdTranscriptInWorker(plan, records, () => {}).restored).toBe(true);
  // Re-archiving publishes the same content-addressed name over the existing link.
  await expect(
    runSessionColdStorageMaintenance({ config: maintenanceConfig(target) }),
  ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  await resetSessionStore({ agentId: "main", storePath: target });
  await expect(fs.stat(rehearsal)).rejects.toMatchObject({ code: "ENOENT" });

  const after = await fs.stat(live);
  expect(await fs.readFile(live)).toEqual(bytes);
  expect([after.ino, after.mtimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.mode]);
});

it.each(["copy", "symlink"] as const)(
  "places archives across volumes by %s without changing the live file",
  async (mode) => {
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("cross"), { code: "EXDEV" }));
    if (mode === "symlink") {
      vi.spyOn(fs, "copyFile").mockRejectedValue(
        Object.assign(new Error("full"), { code: "ENOSPC" }),
      );
    }
    const { source, target, copied, archive } = await snapshotWithFileArchive();
    const live = resolveSessionColdArchivePath(source, archive);
    const before = await fs.readFile(live);
    const placed = await fs.lstat(resolveSessionColdArchivePath(target, archive));

    expect(placed.isSymbolicLink()).toBe(mode === "symlink");
    await expect(restoreFromRehearsal(target, copied)).resolves.toBeDefined();
    expect(await fs.readFile(live)).toEqual(before);
  },
);

it("gives Windows rehearsals a private copy instead of a link", async () => {
  const { source, target, archive } = await snapshotWithFileArchive();
  const live = resolveSessionColdArchivePath(source, archive);
  const placed = resolveSessionColdArchivePath(target, archive);
  await fs.rm(placed);
  // Windows recursive removal may chmod a name before deleting it; a link would reach live data.
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  await linkRehearsalColdArchives(target, source);
  vi.restoreAllMocks();

  const [copied, original] = await Promise.all([fs.lstat(placed), fs.stat(live)]);
  expect(copied.isFile() && copied.ino !== original.ino).toBe(true);
  expect(await fs.readFile(placed)).toEqual(await fs.readFile(live));
});
