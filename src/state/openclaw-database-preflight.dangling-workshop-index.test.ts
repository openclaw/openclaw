import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openStateDatabaseDoctorReadAdmission } from "./openclaw-state-db-maintenance.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(closeOpenClawStateDatabaseForTest);

describe("dangling Workshop index preflight", () => {
  it.each(["runtime", "doctor"] as const)(
    "inspects malformed state for %s without mutating the source",
    async (caller) => {
      const stateDir = tempDirs.make("openclaw-preflight-dangling-workshop-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const statePath = openOpenClawStateDatabase({ env }).path;
      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(statePath);
      try {
        database.exec(
          "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
        );
        database.enableDefensive?.(false);
        database.exec("PRAGMA writable_schema = ON;");
        database
          .prepare(
            `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                         ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
          WHERE type = 'index'
            AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
          )
          .run();
        // SAFETY: PRAGMA schema_version always returns one numeric row for an open database.
        const { schema_version } = database.prepare("PRAGMA schema_version").get() as {
          schema_version: number;
        };
        database.exec(
          `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schema_version + 1};`,
        );
      } finally {
        database.close();
      }
      const sourceDir = path.dirname(statePath);
      const snapshot = () =>
        fs
          .readdirSync(sourceDir)
          .toSorted()
          .map((name) => [name, fs.readFileSync(path.join(sourceDir, name))]);
      const before = snapshot();

      const result = await preflightOpenClawDatabaseSchemas({
        env,
        scope: "state",
        schemaReadAdmission: caller === "doctor" ? openStateDatabaseDoctorReadAdmission : undefined,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      });
      expect(result).toEqual(
        caller === "doctor"
          ? { incompatible: [], indeterminate: [] }
          : {
              incompatible: [],
              indeterminate: [
                {
                  kind: "state",
                  path: statePath,
                  reason: expect.stringContaining("malformed database schema"),
                },
              ],
            },
      );
      expect(snapshot()).toEqual(before);
    },
  );
});
