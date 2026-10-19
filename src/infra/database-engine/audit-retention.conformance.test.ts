import { describe, expect, it } from "vitest";
import {
  assertAuditOverflowRetention,
  assertAuditRetentionCountDrift,
} from "../../audit/audit-event-retention.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each([
  ["overflow", assertAuditOverflowRetention],
  ["count drift", assertAuditRetentionCountDrift],
] as const)("PostgreSQL audit retention: %s", (_name, assertRetention) => {
  useMixedAgentPair("postgres", "postgres");

  it("keeps the retained sequence window without repeated pruning reads", () => {
    withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase();
      expect(isPostgresSqlConnection(database.db)).toBe(true);
      assertRetention(database);
    });
  });
});
