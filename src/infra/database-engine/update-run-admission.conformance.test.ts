import { describe, expect, it } from "vitest";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { openDoctorStateSchemaReadAdmission } from "../../state/openclaw-state-db-doctor-schema.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUpdateRunAdmissionReader } from "../update-run-reader.js";
import { createUpdateRunAsync, recordUpdateRunPhaseAsync } from "../update-run-write.async.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s update ledger admission",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("observes consecutive worker commits without borrowing the anchor content version", async () => {
      const options = { env: { ...process.env } };
      const run = await createUpdateRunAsync({ trigger: "cli" }, options);
      const read = createUpdateRunAdmissionReader(
        { includeRunId: run.runId },
        options,
        openDoctorStateSchemaReadAdmission,
      );
      expect(read().find(({ runId }) => runId === run.runId)?.phase).toBe("requested");
      await recordUpdateRunPhaseAsync(run.runId, "staging", {}, options);
      expect(read().find(({ runId }) => runId === run.runId)?.phase).toBe("staging");
      await recordUpdateRunPhaseAsync(run.runId, "validating", {}, options);
      expect(read().find(({ runId }) => runId === run.runId)?.phase).toBe("validating");
    });

    it("reads the current ledger inside Doctor schema maintenance", async () => {
      const options = { env: { ...process.env } };
      const run = await createUpdateRunAsync({ trigger: "cli" }, options);
      const read = createUpdateRunAdmissionReader(
        { includeRunId: run.runId },
        options,
        openDoctorStateSchemaReadAdmission,
      );
      const pathname = resolveOpenClawStateSqlitePath(options.env);
      const scope = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent() {},
        assertDatabaseAccess: (requested) => expect(requested).toBe(pathname),
      });
      try {
        expect(scope.run(read).find(({ runId }) => runId === run.runId)).toMatchObject({
          phase: "requested",
          status: "running",
        });
      } finally {
        await scope.close();
      }
    });
  },
);
