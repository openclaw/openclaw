import { describe, expect, it } from "vitest";
import {
  assertAuditOverflowRetention,
  assertAuditRetentionCountDrift,
  assertAuditRunAtomicity,
  assertAuditRunReplay,
  assertAuditRunWarmWrite,
} from "../../audit/audit-event-retention.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each([
  ["overflow", assertAuditOverflowRetention],
  ["count drift", assertAuditRetentionCountDrift],
  ["warm run-pair write", assertAuditRunWarmWrite],
  ["run-pair replay", assertAuditRunReplay],
  ["run-pair atomicity", assertAuditRunAtomicity],
] as const)("PostgreSQL audit persistence: %s", (_name, assertPersistence) => {
  useMixedAgentPair("postgres", "postgres");

  it("preserves retained rows and owner sequence facts", () => {
    withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase();
      expect(isPostgresSqlConnection(database.db)).toBe(true);
      assertPersistence(database);
    });
  });
});
