import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { prepareGatewayStartupSessions } from "../../gateway/server-startup-session-migration.js";
import {
  AgentDatabaseAdmissionError,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { prepareOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { createAgentSchemaInspectionWorker } from "../../state/openclaw-agent-schema-inspection-worker.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s deferred Gateway agent inspection",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("inspects a pending agent before preparing and publishing its runtime admission", async () => {
      const env = { ...process.env };
      const options = { agentId: "qa", env };
      const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
      const pathname = database.path;
      withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(pathname));
      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      await using inspector = createAgentSchemaInspectionWorker();
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const owner = admission.adopt();
        const inspection = inspector.inspect({
          ...options,
          pathname,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          verifyCurrentSchemaShape: true,
          inspectOwnership: true,
          requireStartupMigrationReadiness: true,
        });
        const refusals = admission.defer({
          env,
          inspections: [
            {
              target: { agentId: "qa", path: pathname },
              result: inspection.then((result) => {
                assert(result);
                assert.equal(result.version, OPENCLAW_AGENT_SCHEMA_VERSION);
                return { incompatible: [], indeterminate: [] };
              }),
            },
          ],
          reason: "Inspection is still in flight",
        });
        recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
        try {
          expect(await inspection).toMatchObject({
            version: OPENCLAW_AGENT_SCHEMA_VERSION,
            agentSchemaMeta: { agentId: "qa", role: "agent" },
          });
          expect(readAgentDatabaseAdmissionRefusal("qa", { env })).toBe(refusals[0]);
          expect(() => withEngineStoreAdmission(() => openOpenClawAgentDatabase(options))).toThrow(
            AgentDatabaseAdmissionError,
          );
          const log = { info: vi.fn(), warn: vi.fn() };
          admission.activate({
            isCurrent: () => true,
            preparationReady: Promise.resolve(),
            openAgent: ({ assertCurrent, signal }) =>
              prepareOpenClawAgentDatabaseExecution(options, assertCurrent, signal),
            migrateAgent: async ({ assertCurrent }) => {
              const prepared = await prepareGatewayStartupSessions({
                cfg: { agents: { entries: { qa: {} } } },
                env,
                agentIds: new Set(["qa"]),
                assertCurrent,
                log,
              });
              expect(prepared).toHaveLength(1);
              prepared[0]?.assertCurrent();
            },
            publishAgent: async ({ assertCurrent }) => assertCurrent(),
          });
          await admission.pendingPreparation;
          expect(readAgentDatabaseAdmissionRefusal("qa", { env })).toBeUndefined();
          expect(log.warn).not.toHaveBeenCalled();
          expect(() =>
            withEngineStoreAdmission(() => openOpenClawAgentDatabase(options)),
          ).not.toThrow();
        } finally {
          await owner.stop();
          recordAgentDatabaseAdmissions([], { env, source: "startup" });
        }
      });
    });
  },
);
