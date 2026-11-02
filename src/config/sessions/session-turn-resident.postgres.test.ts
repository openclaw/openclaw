import { randomUUID } from "node:crypto";
import { describe, vi } from "vitest";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { createSessionActorWorkerFixture } from "./session-actor-worker.test-support.js";
import { runSessionTurnResidentTests } from "./session-turn-resident.test-support.js";

// mock-isolation: The fixture owns its database lifetime and transcript ordering.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget maintenance is independent of turn preparation.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

describe.skipIf(!mixedAgentConnection)("PostgreSQL resident turn preparation", () => {
  useMixedAgentPair("postgres", "postgres");

  runSessionTurnResidentTests(async (run) => {
    const fixture = withEngineStoreAdmission(() => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionId = randomUUID();
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: `agent:main:turn-resident-${sessionId}`,
        sessionId,
      };
      replaceSessionEntrySync(scope, { sessionId, updatedAt: 1, label: "initial" });
      return createSessionActorWorkerFixture({ database, scope }, (options) =>
        withEngineStoreAdmission(() => openOpenClawAgentDatabase(options)),
      );
    });
    try {
      await run(fixture);
    } finally {
      fixture.close();
    }
  });
});
