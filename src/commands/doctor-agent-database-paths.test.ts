import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  changedStoreFiles,
  listSqliteSidecars,
  snapshotStoreFiles,
} from "../test-utils/store-snapshot.test-support.js";
import { noteDoctorAgentDatabasePathHealth } from "./doctor-agent-database-paths.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  note.mockReset();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

async function cleanRegistry() {
  const root = tempDirs.make("openclaw-doctor-agent-paths-");
  const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
  openOpenClawAgentDatabase({ agentId: "main", env });
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  return { root, env, statePath: resolveOpenClawStateSqlitePath(env) };
}

it("reads a held registry first and leaves a clean one unopened for writing", async () => {
  const { root, env, statePath } = await cleanRegistry();
  const holder = new DatabaseSync(statePath);
  holder.exec("BEGIN IMMEDIATE");
  try {
    const before = snapshotStoreFiles(root);
    // A write transaction would wait out the busy timeout on the held lock and warn.
    expect(noteDoctorAgentDatabasePathHealth({ env, shouldRepair: true })).toEqual([]);
    expect(changedStoreFiles(before, snapshotStoreFiles(root))).toEqual([]);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

it("takes the repair's write path for a registry no connection holds, leaving no sidecars", async () => {
  const { root, env } = await cleanRegistry();
  expect(listSqliteSidecars(root)).toEqual([]);

  // A read-only look would create the WAL sidecars and could not remove them.
  expect(noteDoctorAgentDatabasePathHealth({ env, shouldRepair: true })).toEqual([]);
  closeOpenClawStateDatabaseForTest();

  expect(listSqliteSidecars(root)).toEqual([]);
  expect(note).not.toHaveBeenCalled();
});
