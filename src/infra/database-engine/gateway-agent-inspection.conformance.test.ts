import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareGatewayStartupSessions } from "../../gateway/server-startup-session-migration.js";
import {
  AgentDatabaseAdmissionError,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as version } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { prepareOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { createAgentSchemaInspectionWorker } from "../../state/openclaw-agent-schema-inspection-worker.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { sqliteWorkerPreloadEnv } from "../sqlite-worker-preload.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s deferred Gateway agent inspection",
  (engine) => {
    const fixture = useMixedAgentPair(engine, engine);

    it("inspects a pending agent before preparing and publishing its runtime admission", async () => {
      const env = { ...process.env };
      const options = { agentId: "qa", env };
      const open = () => withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
      const { path: pathname } = open();
      withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(pathname));
      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      const loads = path.join(fixture.root, "inspection-loads.log");
      const preload = path.join(fixture.root, "inspection-loads.cjs");
      // Node's production child loader must not pull SQLite-only inspection owners into PG boot.
      if (engine === "postgres" && !process.versions.bun) {
        fs.writeFileSync(
          preload,
          `if (process.argv[1]?.includes('/openclaw-agent-schema-inspection.worker.')) {
  const fs = require('node:fs');
  require('node:module').registerHooks({ load(url, context, nextLoad) {
    const name = new URL(url).pathname.split('/').pop().replace(/\\.[jt]s$/, '').replace(/-[\\w-]{8}$/, '');
    fs.appendFileSync(${JSON.stringify(loads)}, name + '\\n');
    return nextLoad(url, context);
  }});
}`,
        );
      }
      await using inspector = createAgentSchemaInspectionWorker();
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const owner = admission.adopt();
        const inspect = () =>
          inspector.inspect({
            ...options,
            pathname,
            supportedVersion: version,
            verifyCurrentSchemaShape: true,
            inspectOwnership: true,
            requireStartupMigrationReadiness: true,
          });
        const inspection =
          engine === "postgres" && !process.versions.bun
            ? withEnvAsync(sqliteWorkerPreloadEnv(preload), inspect)
            : inspect();
        const refusals = admission.defer({
          env,
          inspections: [
            {
              target: { agentId: "qa", path: pathname },
              result: inspection.then(() => ({ incompatible: [], indeterminate: [] })),
            },
          ],
          reason: "Inspection is still in flight",
        });
        recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
        try {
          expect(await inspection).toMatchObject({
            version,
            agentSchemaMeta: { agentId: "qa", role: "agent" },
          });
          if (engine === "postgres" && !process.versions.bun) {
            const loaded = fs.readFileSync(loads, "utf8").trim().split("\n");
            expect(loaded).toContain("openclaw-agent-schema-inspection.worker");
            expect(
              loaded.filter((name) =>
                [
                  "openclaw-agent-schema-inspection",
                  "openclaw-state-schema-preflight",
                  "sqlite-maintenance-cache",
                ].includes(name),
              ),
            ).toEqual([]);
          }
          expect(readAgentDatabaseAdmissionRefusal("qa", { env })).toBe(refusals[0]);
          expect(open).toThrow(AgentDatabaseAdmissionError);
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
          expect(open).not.toThrow();
        } finally {
          await owner.stop();
          recordAgentDatabaseAdmissions([], { env, source: "startup" });
        }
      });
    });
  },
);
