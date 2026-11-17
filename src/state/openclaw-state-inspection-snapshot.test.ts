import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { createSqliteFamilyEngines } from "../infra/database-engine/selection-fixture.test-support.js";
import { getActiveOpenClawStateDatabaseReadSnapshotAsync } from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withArtifactPreservingStateSnapshot } from "./openclaw-state-inspection-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it("shares one private image with SQLite readers and none with readers selected for PostgreSQL", async () => {
  const stateDir = tempDirs.make("openclaw-state-inspection-snapshot-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("XDG_CACHE_HOME", path.join(stateDir, "cache"));
  const databasePath = openOpenClawStateDatabase().path;
  await closeOpenClawStateDatabaseAsync();

  const seen = await withArtifactPreservingStateSnapshot(new AbortController().signal, async () => {
    const first = await getActiveOpenClawStateDatabaseReadSnapshotAsync();
    const again = await getActiveOpenClawStateDatabaseReadSnapshotAsync();
    // Status opens this scope before the configured engine is selected for its ledger reads.
    const postgres = await withDatabaseEngineSelection(
      {
        effectiveEngines: createSqliteFamilyEngines({ state: "postgres" }),
        postgres: { connection: "postgres://fixture.invalid/state", schemaPrefix: "state" },
      },
      () => getActiveOpenClawStateDatabaseReadSnapshotAsync(),
    );
    return { first: first?.location, again: again?.location, postgres };
  });

  expect(seen.first).toBeDefined();
  expect(seen.first).not.toBe(databasePath);
  expect(seen.again).toBe(seen.first);
  expect(seen.postgres).toBeUndefined();
});
