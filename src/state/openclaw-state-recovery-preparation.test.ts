import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { versionedStateMigrations } from "./openclaw-state-db-maintenance.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { prepareOpenClawStateRecoveryCopy } from "./openclaw-state-recovery-preparation.js";
import { removePreparedWorkerOwnershipColumns } from "./openclaw-state-schema-v17.test-support.js";

describe("shared-state recovery preparation", () => {
  it.each([
    { older: 15, newer: 16, change: "preserve" },
    { older: 16, newer: 17, change: "preserve" },
    { older: 16, newer: 17, change: "baseline worker purpose" },
    ...[
      "preserve",
      "new proposal",
      "owner collision",
      "unknown schema",
      "prepared worker",
      "unknown table",
      "lost authority",
    ].map((change) => ({ older: 15, newer: 17, change })),
  ])(
    "prepares real v$older -> v$newer with $change, leaving B/C immutable",
    async ({ older, newer, change }) =>
      withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const baselinePath = state.path("baseline.sqlite");
        const candidatePath = state.path("candidate.sqlite");
        const targetPath = state.path("prepared.sqlite");
        const store = openOpenClawStateDatabase({ env: state.env, path: baselinePath });
        store.db.exec(`
        ALTER TABLE skill_workshop_proposals ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
        ALTER TABLE skill_workshop_proposals ADD COLUMN claim_released_time INTEGER;
        DROP INDEX idx_skill_workshop_collection_reviews_owner_time;
        ALTER TABLE skill_workshop_collection_reviews RENAME COLUMN owner_agent_id TO workspace_dir;
        CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
          ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC);
        INSERT INTO skill_workshop_proposals
          (proposal_id,record_json,owner_agent_id,workspace_dir,kind,status,created_at,updated_at,draft_hash)
          VALUES ('kept','{}','main','/fixture/workspace','create','pending','before','before','hash'),
                 ('deleted','{}','main','/fixture/workspace','create','pending','before','before','hash');
        INSERT INTO skill_workshop_collection_reviews VALUES
          ('review','/fixture/workspace','backup',1,'[]','[]','[]');
        INSERT INTO delivery_queue_entries(queue_name,id,status,entry_json,enqueued_at,updated_at)
          VALUES ('test','acknowledged','pending','{}',1,1);
        PRAGMA user_version=15;
        UPDATE schema_meta SET schema_version=15,app_version='older' WHERE meta_key='primary';
        DELETE FROM config_machine_state WHERE state_key='state.schema.contentVersion';
      `);
        removePreparedWorkerOwnershipColumns(store.db);
        store.db.exec(
          "ALTER TABLE worker_environments DROP COLUMN preparation_purpose; PRAGMA wal_checkpoint(TRUNCATE)",
        );
        if (older === 16) {
          for (const migration of versionedStateMigrations) {
            if (migration.version === 16) {
              migration.migrate(store.db, 15);
            }
          }
          store.db.exec(
            "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16 WHERE meta_key='primary'",
          );
        }
        if (change === "baseline worker purpose") {
          store.db.exec("ALTER TABLE worker_environments ADD COLUMN preparation_purpose TEXT");
          store.db.exec(`INSERT INTO worker_environments
          (environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,state,
           created_at_ms,updated_at_ms,state_changed_at_ms,preparation_purpose)
          VALUES ('baseline','provider','profile','{}','operation','destroyed',1,1,1,'kept')`);
        }
        closeOpenClawStateDatabaseForTest();
        await fs.copyFile(baselinePath, candidatePath);
        const candidate = new (requireNodeSqlite().DatabaseSync)(candidatePath);
        try {
          candidate.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
          for (const migration of versionedStateMigrations) {
            if (migration.version > older && migration.version <= newer) {
              migration.migrate(candidate, older);
            }
          }
          candidate.exec(`
          PRAGMA user_version=${newer};
          UPDATE schema_meta SET schema_version=${newer} WHERE meta_key='primary';
          DELETE FROM delivery_queue_entries WHERE id='acknowledged';
          INSERT INTO delivery_queue_entries(queue_name,id,status,entry_json,enqueued_at,updated_at)
            VALUES ('test','new-user-row','pending','{"new":true}',2,2);
          UPDATE skill_workshop_proposals SET record_json='{"userEdit":true}',updated_at='after'
            WHERE proposal_id='kept';
          DELETE FROM skill_workshop_proposals WHERE proposal_id='deleted';
          COMMIT;
        `);
          if (change === "new proposal") {
            candidate.exec(`INSERT INTO skill_workshop_proposals
            (proposal_id,record_json,owner_agent_id,kind,status,created_at,updated_at,draft_hash)
            VALUES ('new','{}','main','create','pending','now','now','new-hash')`);
          } else if (change === "owner collision") {
            candidate.exec(
              "UPDATE skill_workshop_proposals SET owner_agent_id='other' WHERE proposal_id='kept'",
            );
          } else if (change === "unknown schema") {
            candidate.exec(
              "ALTER TABLE delivery_queue_entries RENAME COLUMN entry_json TO unknown_payload",
            );
          } else if (change === "unknown table") {
            candidate.exec(
              "CREATE TABLE unknown_owner(value TEXT); INSERT INTO unknown_owner VALUES ('new user fact')",
            );
          } else if (change === "prepared worker") {
            candidate.exec(`INSERT INTO worker_environments
            (environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,state,
             created_at_ms,updated_at_ms,state_changed_at_ms,last_activated_at_ms)
            VALUES ('worker','provider','profile','{}','operation','destroyed',1,1,1,1)`);
          }
          candidate.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          candidate.close();
        }
        const baselineBytes = await fs.readFile(baselinePath);
        const candidateBytes = await fs.readFile(candidatePath);
        let assertions = 0;
        const prepare = prepareOpenClawStateRecoveryCopy({
          baselinePath,
          candidatePath,
          targetPath,
          assertOwned() {
            if (change === "lost authority" && ++assertions === 3) {
              throw new Error("recovery refused: physical owner lost");
            }
          },
        });
        if (change === "preserve" || change === "baseline worker purpose") {
          await prepare;
          const prepared = new (requireNodeSqlite().DatabaseSync)(targetPath, { readOnly: true });
          try {
            expect(prepared.prepare("PRAGMA user_version").get()).toEqual({ user_version: older });
            expect(prepared.prepare("SELECT id FROM delivery_queue_entries").all()).toEqual([
              { id: "new-user-row" },
            ]);
            expect(
              prepared
                .prepare(
                  `SELECT proposal_id,${older === 15 ? "workspace_dir" : "owner_agent_id"},record_json FROM skill_workshop_proposals`,
                )
                .all(),
            ).toEqual([
              {
                proposal_id: "kept",
                ...(older === 15
                  ? { workspace_dir: "/fixture/workspace" }
                  : { owner_agent_id: "main" }),
                record_json: '{"userEdit":true}',
              },
            ]);
            expect(
              prepared
                .prepare(
                  `SELECT ${older === 15 ? "workspace_dir" : "owner_agent_id"} FROM skill_workshop_collection_reviews`,
                )
                .get(),
            ).toEqual(
              older === 15 ? { workspace_dir: "/fixture/workspace" } : { owner_agent_id: "main" },
            );
            if (change === "baseline worker purpose") {
              expect(
                prepared
                  .prepare(
                    "SELECT preparation_purpose FROM worker_environments WHERE environment_id='baseline'",
                  )
                  .get(),
              ).toEqual({ preparation_purpose: "kept" });
            }
            expect(prepared.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
          } finally {
            prepared.close();
          }
        } else {
          await expect(prepare).rejects.toThrow(/recovery refused/);
        }
        expect(await fs.readFile(baselinePath)).toEqual(baselineBytes);
        expect(await fs.readFile(candidatePath)).toEqual(candidateBytes);
      }),
  );
});
