import { describe, expect, it } from "vitest";
import { assertMessageProgressOverflowRetention } from "../../audit/message-progress-retention.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL message progress retention", () => {
  useMixedAgentPair("postgres", "postgres");

  it("retains the newest rows across sequence gaps and keeps the cached count", () => {
    withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase();
      expect(isPostgresSqlConnection(database.db)).toBe(true);
      assertMessageProgressOverflowRetention(database);
    });
  });
});
