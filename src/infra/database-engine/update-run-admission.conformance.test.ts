import { describe, expect, it, vi } from "vitest";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { openDoctorStateSchemaReadAdmission } from "../../state/openclaw-state-db-doctor-schema.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as outcomeTelemetry from "../update-result-telemetry.js";
import { createUpdateRunAdmissionReader } from "../update-run-reader.js";
import {
  createUpdateRunAsync,
  finishUpdateRunAsync,
  recordUpdateRunPhaseAsync,
} from "../update-run-write.async.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const rejectBookkeeping = `
  CREATE FUNCTION reject_update_result_bookkeeping() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.state_key = 'telemetry.updateResults' THEN
      RAISE EXCEPTION 'synthetic bookkeeping failure';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER reject_update_result_bookkeeping BEFORE INSERT OR UPDATE ON config_machine_state
    FOR EACH ROW EXECUTE FUNCTION reject_update_result_bookkeeping();`;

function execState(sql: string) {
  withEngineStoreAdmission(() => runOpenClawStateWriteTransaction(({ db }) => db.exec(sql)));
}

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

    // A failed statement aborts the whole PostgreSQL transaction unless bookkeeping
    // runs in its own savepoint; the update write must commit regardless.
    it.runIf(engine === "postgres")(
      "commits update writes when outcome bookkeeping fails",
      async () => {
        // Outcome policy reads CI; clear it so admission and claims actually run.
        const options = { env: { ...process.env, CI: undefined } };
        const settled = await createUpdateRunAsync({ trigger: "cli" }, options);
        execState(rejectBookkeeping);
        const send = vi.spyOn(outcomeTelemetry, "sendUpdateResultTelemetry");
        try {
          const admitted = await createUpdateRunAsync({ trigger: "cli" }, options);
          await expect(
            finishUpdateRunAsync(settled.runId, { status: "failed" }, options),
          ).resolves.toMatchObject({ status: "failed" });
          const read = createUpdateRunAdmissionReader(
            { includeRunId: admitted.runId },
            options,
            openDoctorStateSchemaReadAdmission,
          );
          expect(read().find(({ runId }) => runId === admitted.runId)?.status).toBe("running");
          expect(send).not.toHaveBeenCalled();
        } finally {
          send.mockRestore();
          execState(`DROP TRIGGER reject_update_result_bookkeeping ON config_machine_state;
            DROP FUNCTION reject_update_result_bookkeeping();`);
        }
      },
    );
  },
);
