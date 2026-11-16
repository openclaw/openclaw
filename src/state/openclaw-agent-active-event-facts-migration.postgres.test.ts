import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL active event facts migration", () => {
  it("preserves agent40 rows, refuses the old reader, and follows active-row deletion", () => {
    withEngineStoreAdmission(() => {
      const migration = agentEngineSchema.postgresMigrations?.find((step) => step.version === 41);
      if (!migration) {
        throw new Error("Missing agent41 migration");
      }
      const source = {
        ...agentEngineSchema,
        ...migration.fromSchema,
        version: 40,
        postgresMigrations: [],
      };
      const target = { ...agentEngineSchema, ...migration.schema, version: 41 };
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("active-facts-upgrade-"),
        connection: connection!,
        schemaPrefix: "active_facts_upgrade_test",
        schema: source,
      });
      const original = fixture.open();
      original.runTransaction(() => {
        original.exec(`INSERT INTO schema_meta (meta_key,role,schema_version,agent_id,created_at,updated_at)
          VALUES ('primary','agent',40,'main',1,1);
          INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at)
          VALUES ('agent:main:retained','retained','{"sessionId":"retained","updatedAt":1}',1);
          INSERT INTO session_windows (session_id,session_key,created_at,updated_at)
          VALUES ('retained','agent:main:retained',1,1);
          INSERT INTO transcript_events (session_id,seq,event_json,created_at)
          VALUES ('retained',1,'{"type":"message","message":{"role":"user"}}',1);
          INSERT INTO session_transcript_active_events (session_id,active_position,event_seq,context_eligible)
          VALUES ('retained',0,1,1);`);
      });
      const retained = original.prepare("SELECT * FROM transcript_events").all();
      fixture.invalidate();
      const upgraded = fixture.open(target);
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 41,
      });
      expect(upgraded.prepare("SELECT * FROM transcript_events").all()).toEqual(retained);
      expect(upgraded.prepare("SELECT * FROM session_transcript_active_event_facts").all()).toEqual(
        [],
      );
      fixture.invalidate();
      expect(() => fixture.open(source)).toThrow(/newer|version.*41/iu);
      const reopened = fixture.open(target);
      reopened.exec(
        "INSERT INTO session_transcript_active_event_facts VALUES ('retained',1,46,'{}')",
      );
      reopened.exec("DELETE FROM session_transcript_active_events WHERE session_id='retained'");
      expect(reopened.prepare("SELECT * FROM session_transcript_active_event_facts").all()).toEqual(
        [],
      );
      expect(reopened.prepare("SELECT * FROM transcript_events").all()).toEqual(retained);
    });
  });
});
