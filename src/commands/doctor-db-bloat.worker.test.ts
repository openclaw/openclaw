import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "../flows/doctor-health-contributions.test-support.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const notes = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: notes }));

afterEach(() => vi.restoreAllMocks());

it.each([
  {
    autoVacuum: "INCREMENTAL",
    remedy: /incremental vacuum will release it gradually\./,
  },
  {
    autoVacuum: "NONE",
    remedy:
      /offline Doctor SQLite compaction to reclaim it and enable incremental vacuum.*gateway stopped.*https:\/\/docs\.openclaw\.ai\/cli\/doctor\/sqlite-maintenance/,
  },
])(
  "reports $autoVacuum database bloat off the host without changing stored artifacts",
  async ({ autoVacuum, remedy }) => {
    await withOpenClawTestState({ label: "doctor-bloat-worker" }, async (state) => {
      const contributions = resolveDoctorHealthContributions().filter(
        ({ id }) => id === "doctor:db-bloat",
      );
      expect(contributions).toHaveLength(1);
      const context = createDoctorHealthFlowContext({ env: state.env });
      openOpenClawStateDatabase({ env: state.env });
      notes.mockClear();
      await runDoctorHealthContributionList(context, contributions);
      expect(notes).not.toHaveBeenCalled();
      const databasePath = state.statePath("bloat.sqlite");
      const database = openNodeSqliteDatabase(databasePath);
      try {
        database.exec(`PRAGMA auto_vacuum = ${autoVacuum}`);
        database.exec("CREATE TABLE payload (value BLOB)");
        database.prepare("INSERT INTO payload VALUES (zeroblob(?))").run(128 * 1024 * 1024);
        database.exec("DELETE FROM payload");
      } finally {
        database.close();
      }
      registerOpenClawAgentDatabase({ agentId: "bloat", path: databasePath, env: state.env });
      const snapshot = async () => {
        const files = (await fs.readdir(state.stateDir, { recursive: true })).toSorted();
        const hashes = await Promise.all(
          files.map(async (file) => {
            const pathname = state.statePath(file);
            return (await fs.stat(pathname)).isFile()
              ? [
                  file,
                  createHash("sha256")
                    .update(await fs.readFile(pathname))
                    .digest("hex"),
                ]
              : [file, null];
          }),
        );
        return hashes;
      };
      const before = await snapshot();
      notes.mockClear();
      const sql = observeMainThreadSql();
      try {
        await runDoctorHealthContributionList(context, contributions);
        expect(notes).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(/agent DB \(bloat\): .* reclaimable free pages;/),
          "SQLite database size",
        );
        expect(notes.mock.calls[0]?.[0]).toMatch(remedy);
        sql.expectIdle();
        expect(await snapshot()).toEqual(before);
      } finally {
        sql.restore();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);
