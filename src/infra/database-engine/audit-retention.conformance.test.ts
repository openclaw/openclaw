import { describe, expect, it } from "vitest";
import { assertAuditOverflowRetention } from "../../audit/audit-event-retention.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL audit retention", () => {
  useMixedAgentPair("postgres", "postgres");

  it("prunes overflow in one statement and keeps the retained sequence window", () => {
    withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase();
      expect(isPostgresSqlConnection(database.db)).toBe(true);
      assertAuditOverflowRetention(database);
    });
  });
});
