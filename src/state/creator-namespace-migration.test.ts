import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "./openclaw-agent-db.test-support.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const actor = { type: "human", id: "same-id", label: "Retain me" } as const;
describe("creator namespace upgrades", () => {
  it("qualifies historical creator seams without losing provenance", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const options = { agentId: "main", env: state.env };
      const cases = [
        ["operator", "profile"],
        ["run", "profile"],
        ["channel", "channel"],
        ["cron", "unknown"],
        ["spawn", "unknown"],
        ["talk", "unknown"],
        [undefined, "unknown"],
      ] as const;
      for (const [via] of cases) {
        await upsertSessionEntryCore(
          { ...options, sessionKey: `agent:main:${via ?? "unknown"}` },
          {
            sessionId: via ?? "unknown",
            updatedAt: 10,
            createdAt: 5,
            createdVia: via,
            createdActor: { ...actor, source: "unknown" },
            sandbox: "required",
            visibility: "draft",
          },
        );
      }
      await upsertSessionEntryCore(
        { ...options, sessionKey: "agent:main:legacy" },
        {
          sessionId: "legacy",
          updatedAt: 10,
          createdVia: "operator",
        },
      );
      const databasePath = openOpenClawAgentDatabase(options).path;
      // Retire automatic maintenance before constructing the historical snapshot.
      closeOpenClawAgentDatabasesForTest();
      const db = openNodeSqliteDatabase(databasePath);
      try {
        restoreEmptyV21StorageForHistoricalFixture(db);
        removeCanonicalValidationFromHistoricalAgentFixture(db);
        db.exec(
          `UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdBy', json('{"id":"old-id","label":"Legacy label"}')) WHERE session_key = 'agent:main:legacy'`,
        );
        db.exec(`UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.createdActor.source');
        PRAGMA user_version = 18; UPDATE schema_meta SET schema_version = 18;`);
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () =>
          ensureOpenClawAgentDatabaseSchema(db, { ...options, path: databasePath }),
        );
      } finally {
        db.close();
      }
      for (const [via, source] of cases) {
        expect(
          loadSessionEntry({ ...options, sessionKey: `agent:main:${via ?? "unknown"}` }),
        ).toMatchObject({
          createdActor: { ...actor, source },
          sandbox: "required",
          visibility: "draft",
          createdAt: 5,
        });
      }
      expect(loadSessionEntry({ ...options, sessionKey: "agent:main:legacy" })).toMatchObject({
        createdActor: { type: "human", source: "unknown", id: "old-id", label: "Legacy label" },
      });
    });
  });

  it("retains historical cron attribution as unknown through the actual store upgrade", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronStore(storePath, {
        version: 1,
        jobs: [makeCronJob({ createdActor: { ...actor, source: "profile" } })],
      });
      const initial = openOpenClawStateDatabase({ env: state.env });
      addPreCutoverClientCredentialTablesForTest(initial.db);
      initial.db
        .exec(`UPDATE cron_jobs SET job_json = json_remove(job_json, '$.createdActor.source');
        PRAGMA user_version = 13; UPDATE schema_meta SET schema_version = 13;`);
      await closeStateDatabaseForTest();
      await withStateMigrationBackupForTest({ env: state.env }, () =>
        openOpenClawStateDatabase({ env: state.env }),
      );
      const reopened = openOpenClawStateDatabase({ env: state.env });
      expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
        createdActor: { ...actor, source: "unknown" },
      });
    });
  });
});
