import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { listSqliteSidecars } from "../test-utils/store-snapshot.test-support.js";
import { noteDoctorAgentDatabasePathHealth } from "./doctor-agent-database-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it("takes the repair's write path for a registry no connection holds, leaving no sidecars", async () => {
  const root = tempDirs.make("openclaw-doctor-agent-paths-");
  const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
  openOpenClawAgentDatabase({ agentId: "main", env });
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  expect(listSqliteSidecars(root)).toEqual([]);

  // A read-only look would create the WAL sidecars and could not remove them.
  expect(noteDoctorAgentDatabasePathHealth({ env, shouldRepair: true })).toEqual([]);
  closeOpenClawStateDatabaseForTest();

  expect(listSqliteSidecars(root)).toEqual([]);
});
