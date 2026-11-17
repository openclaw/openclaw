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
import {
  createStateSnapshotInput,
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
      const snapshot = runUpdateCandidateSnapshotWorker(
        createStateSnapshotInput(state.root, state.stateDir, targetStateDir),
      );
      if (condition !== "valid") {
        await expect(snapshot).rejects.toThrow(error);
      } else {
        await snapshot;
        expect(await fs.readFile(fixture.scope.storePath)).toEqual(original);
        expect(await fs.readFile(file)).toEqual(bytes);
        // A rehearsal must not depend on any live database or cold file after capture.
        await fs.rename(state.stateDir, state.path("unavailable-source"));
        const scope = {
          ...fixture.scope,
          storePath: path.join(targetStateDir, relative),
          env: { ...state.env, OPENCLAW_STATE_DIR: targetStateDir },
        };
        await restoreSessionColdTranscript(scope);
        expect(await loadTranscriptEvents(scope)).toEqual(events);
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        using database = openNodeSqliteDatabase(scope.storePath, { readOnly: true });
        expect(fixture.snapshot(database)).toEqual(fixture.original);
      }
    });
  },
);
