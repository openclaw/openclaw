import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { UpdateDoctorError } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";

function createDoctorAgentLeaseRefusal(env: NodeJS.ProcessEnv, cause?: unknown): UpdateDoctorError {
  const message =
    "Doctor could not enter maintenance. An agent database is in use. Stop other OpenClaw processes using this state, then retry the update.";
  return new UpdateDoctorError(
    message,
    [
      createUpdateFailureFact(
        { check: "doctor", code: "agent-database-lease-active", message },
        env,
      ),
    ],
    { cause },
  );
}

export async function preflightExternalDoctorAgentLease(env: NodeJS.ProcessEnv): Promise<void> {
  // An external parent may leave the serving Gateway running. Diagnose an
  // active agent lease before that Gateway's lifecycle lock masks it.
  // This negative-only observation grants no maintenance authority: both
  // coordinators and the held-owner lease assertion remain mandatory.
  const { readActiveOpenClawAgentDatabaseLeasesReadOnly } =
    await import("../state/openclaw-agent-db-lease.js");
  let activeAgentLease = false;
  try {
    activeAgentLease =
      readActiveOpenClawAgentDatabaseLeasesReadOnly({ env }, openDoctorStateSchemaReadAdmission)
        .length > 0;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    // Diagnostic failure is not admission. The mandatory held-owner
    // check below still classifies unreadable state and unknown errors.
  }
  if (activeAgentLease) {
    throw createDoctorAgentLeaseRefusal(env);
  }
}

/** The caller holds both lifecycle coordinators; this check never opens a state writer. */
export async function assertDoctorAgentLeaseAdmission(env: NodeJS.ProcessEnv): Promise<void> {
  const { assertNoOpenClawAgentDatabaseLeasesReadOnly, OpenClawAgentDatabaseLeaseActiveError } =
    await import("../state/openclaw-agent-db-lease.js");
  try {
    assertNoOpenClawAgentDatabaseLeasesReadOnly({ env }, openDoctorStateSchemaReadAdmission);
  } catch (error) {
    if (error instanceof OpenClawAgentDatabaseLeaseActiveError) {
      throw createDoctorAgentLeaseRefusal(env, error);
    }
    // Classify unreadable state under the held owners without opening a writer.
    const { preflightOpenClawDatabaseSchemas } =
      await import("../state/openclaw-database-preflight.js");
    const schemas = await preflightOpenClawDatabaseSchemas({
      env,
      scope: "state",
      openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    });
    const unreadable = schemas.indeterminate.find((database) => database.kind === "state");
    if (unreadable) {
      throw new DoctorUnreadableStateDatabaseError(unreadable.path, unreadable.reason);
    }
    throw error;
  }
}
