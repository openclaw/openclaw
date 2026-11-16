import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginAgentToolUsageInDatabase,
  flushAgentToolUsageInDatabase,
  readAgentToolUsageInDatabase,
  readAgentToolUsageLiveRunsInDatabase,
  resetAgentToolUsageInDatabase,
} from "../config/sessions/tool-usage.kernel.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL tool usage migration", () => {
  it("upgrades agent41 and applies the same decay and stale-batch reset contract", () => {
    withEngineStoreAdmission(() => {
      const migration = agentEngineSchema.postgresMigrations?.find((step) => step.version === 42);
      if (!migration) {
        throw new Error("Missing agent42 migration");
      }
      const source = {
        ...agentEngineSchema,
        ...migration.fromSchema,
        version: 41,
        postgresMigrations: [],
      };
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("tool-usage-upgrade-"),
        connection: connection!,
        schemaPrefix: "tool_usage_test",
        schema: source,
      });
      const original = fixture.open();
      original.exec(
        "INSERT INTO schema_meta (meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES ('primary','agent',41,'main',1,1)",
      );
      fixture.invalidate();
      const upgraded = fixture.open(agentEngineSchema);
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 42,
      });
      expect(readAgentToolUsageInDatabase(upgraded, 100).rows).toEqual([]);
      upgraded.runTransaction(() => {
        const state = beginAgentToolUsageInDatabase(upgraded, 100, "synthetic-live-run");
        expect(readAgentToolUsageLiveRunsInDatabase(upgraded, 100)).toEqual(
          new Set(["synthetic-live-run"]),
        );
        const toolId = "openclaw:synthetic:lookup";
        flushAgentToolUsageInDatabase(upgraded, {
          generation: state.generation,
          now: 100,
          rows: [{ toolId, score: 2, updatedAt: 100 }],
        });
        const later = 100 + 14 * 86_400_000;
        flushAgentToolUsageInDatabase(upgraded, {
          generation: state.generation,
          now: later,
          rows: [{ toolId, score: 1, updatedAt: later }],
        });
        expect(readAgentToolUsageInDatabase(upgraded, later).rows).toEqual([
          { toolId, score: 2, updatedAt: later },
        ]);
        resetAgentToolUsageInDatabase(upgraded, later);
        expect(
          flushAgentToolUsageInDatabase(upgraded, {
            generation: state.generation,
            now: later,
            rows: [{ toolId, score: 10, updatedAt: later }],
          }),
        ).toBe(false);
        expect(readAgentToolUsageInDatabase(upgraded, later).rows).toEqual([]);
      });
      fixture.invalidate();
      expect(() => fixture.open(source)).toThrow(/newer|version.*42/iu);
    });
  });
});
