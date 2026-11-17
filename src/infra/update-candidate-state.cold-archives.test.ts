import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { copyColdArchives } from "./update-candidate-cold-archives.worker.js";
import { measureUpdateStateFiles } from "./update-candidate-io.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import { collectStateDatabasePaths } from "./update-candidate-state.js";
import {
  createStateSnapshotInput,
  materializeUpdateCandidateStateWorker,
  runUpdateCandidateSnapshotWorker,
} from "./update-candidate-state.test-support.js";

it.each(["valid", "missing", "corrupt"] as const)(
  "rehearses file-backed cold history while preserving live %s archive diagnostics",
  async (condition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
      const fixture = await createSessionColdStorageFixture(state.statePath(relative));
      const events = await loadTranscriptEvents(fixture.scope);
      await expect(
        runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) }),
      ).resolves.toMatchObject({ archivedTranscripts: 1 });
      const archive = readSessionColdTranscript(fixture.database(), fixture.scope.sessionId);
      expect(
        fixture
          .database()
          .prepare("SELECT storage, archive_blob FROM session_transcript_cold_archives")
          .all(),
      ).toEqual([{ storage: "file", archive_blob: null }]);
      if (!archive) {
        throw new Error("Expected a file-backed archive");
      }
      const file = resolveSessionColdArchivePath(fixture.scope.storePath, archive.archive_name);
      const bytes = await fs.readFile(file);
      if (condition === "missing") {
        await fs.unlink(file);
      } else if (condition === "corrupt") {
        await fs.writeFile(file, Buffer.alloc(bytes.length));
      }
      const error = condition === "missing" ? "missing or unreadable" : "failed verification";
      if (condition !== "valid") {
        await expect(restoreSessionColdTranscript(fixture.scope)).rejects.toThrow(error);
      }
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      const original = await fs.readFile(fixture.scope.storePath);
      const targetStateDir = state.path("rehearsal");
      await runUpdateCandidateSnapshotWorker(
        createStateSnapshotInput(state.root, state.stateDir, targetStateDir),
      );
      expect(await fs.readFile(fixture.scope.storePath)).toEqual(original);
      const projected = resolveSessionColdArchivePath(
        path.join(targetStateDir, relative),
        archive.archive_name,
      );
      if (condition === "missing") {
        // The rehearsal mirrors lost live payloads; only a step that reads one fails.
        await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(projected)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(file)).toEqual(
          condition === "corrupt" ? Buffer.alloc(bytes.length) : bytes,
        );
      }
      {
        using copy = openNodeSqliteDatabase(path.join(targetStateDir, relative), {
          readOnly: true,
        });
        expect(readSessionColdTranscript(copy, fixture.scope.sessionId)).toEqual(archive);
        expect(
          copy.prepare("SELECT archive_blob FROM session_transcript_cold_archives").get(),
        ).toEqual({ archive_blob: null });
      }
      if (condition !== "missing") {
        const linked = await fs.stat(projected, { bigint: true });
        const source = await fs.stat(file, { bigint: true });
        expect({ dev: linked.dev, ino: linked.ino }).toEqual({
          dev: source.dev,
          ino: source.ino,
        });
      }
      // A rehearsal must not depend on any live database or cold file after capture.
      await fs.rename(state.stateDir, state.path("unavailable-source"));
      const scope = {
        ...fixture.scope,
        storePath: path.join(targetStateDir, relative),
        env: { ...state.env, OPENCLAW_STATE_DIR: targetStateDir },
      };
      if (condition !== "valid") {
        await expect(restoreSessionColdTranscript(scope)).rejects.toThrow(error);
        return;
      }
      await restoreSessionColdTranscript(scope);
      expect(await loadTranscriptEvents(scope)).toEqual(events);
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      using database = openNodeSqliteDatabase(scope.storePath, { readOnly: true });
      expect(fixture.snapshot(database)).toEqual(fixture.original);
    });
  },
);

it("includes cold payload bytes in the released parent's capacity allowance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) });
    const archive = readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)!;
    const payload = await fs.stat(
      resolveSessionColdArchivePath(fixture.scope.storePath, archive.archive_name),
    );
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const candidateRoot = state.path("candidate");
    await materializeUpdateCandidateStateWorker(candidateRoot);
    const env = { ...state.env, TMPDIR: state.root, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const input = { stateDir: state.stateDir, env, config: {} };
    const databases = await collectStateDatabasePaths(input);
    const paths = [...databases.values()].map(({ spellings }) => spellings[0]);
    // Rollback journals keep metadata inspection from creating transient WAL index bytes.
    for (const family of (await measureUpdateStateFiles(paths)).families) {
      if (family.bytes > 0) {
        using database = openNodeSqliteDatabase(family.path);
        database.exec("PRAGMA journal_mode = DELETE;");
      }
    }
    const size = await measureUpdateStateFiles(paths);
    const result = await prepareUpdateCandidateStateSnapshot({
      ...input,
      candidateRoot,
      workerEnv: () => env,
    });
    expect(result.snapshotCapacity.pluginBytes).toBe(payload.size);
    expect(result.snapshotCapacity.requiredBytes).toBe(
      size.bytes + size.largest + payload.size + 64 * 1024 * 1024,
    );
  });
});

it("reports referenced cold payloads already missing from live state instead of refusing", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) });
    const archive = readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)!;
    await fs.unlink(resolveSessionColdArchivePath(fixture.scope.storePath, archive.archive_name));
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const candidateRoot = state.path("candidate");
    await materializeUpdateCandidateStateWorker(candidateRoot);
    const env = { ...state.env, TMPDIR: state.root, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const result = await prepareUpdateCandidateStateSnapshot({
      stateDir: state.stateDir,
      env,
      config: {},
      candidateRoot,
      workerEnv: () => env,
    });
    expect(result.snapshotCapacity.pluginBytes).toBe(0);
    expect(result.snapshotWarnings).toEqual([
      expect.stringContaining("1 referenced cold transcript archive file(s) are missing"),
    ]);
  });
});

it("copies cold payloads on Windows so link removal cannot chmod the live file", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) });
    const archive = readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)!;
    const source = resolveSessionColdArchivePath(fixture.scope.storePath, archive.archive_name);
    const targetStorePath = state.path(
      "rehearsal",
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await copyColdArchives(fixture.database(), fixture.scope.storePath, targetStorePath);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    const target = resolveSessionColdArchivePath(targetStorePath, archive.archive_name);
    const [copied, live] = await Promise.all([
      fs.stat(target, { bigint: true }),
      fs.stat(source, { bigint: true }),
    ]);
    expect(copied.ino).not.toBe(live.ino);
    expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  });
});
