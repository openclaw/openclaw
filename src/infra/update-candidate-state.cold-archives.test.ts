import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runUpdateCandidateSnapshotWorker } from "./update-candidate-state.test-support.js";

it("copies file-backed transcripts into an independently usable update rehearsal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
    const fixture = await createSessionColdStorageFixture(state.statePath(relative));
    await expect(
      runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    const archive = readSessionColdTranscript(fixture.database(), fixture.scope.sessionId);
    if (!archive || archive.storage !== "file") {
      throw new Error("Expected a file-backed archive");
    }
    const source = resolveSessionColdArchivePath(fixture.scope.storePath, archive.archive_name);
    const expected = await fs.readFile(source);
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const targetStateDir = state.path("rehearsal");
    await runUpdateCandidateSnapshotWorker({
      candidateRoot: state.path("candidate"),
      stateDir: state.stateDir,
      targetStateDir,
      config: {},
      env: state.env,
    });
    // The fixture's rehearsal remains usable after the source pathname disappears.
    await fs.rename(source, source + ".retired");
    const destination = resolveSessionColdArchivePath(
      path.join(targetStateDir, relative),
      archive.archive_name,
    );
    await expect(fs.readFile(destination)).resolves.toEqual(expected);
  });
});
