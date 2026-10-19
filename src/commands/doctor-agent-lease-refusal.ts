import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { sleep } from "../utils/sleep.js";
import {
  DOCTOR_MAINTENANCE_WAIT_PROGRESS_INTERVAL_MS,
  formatDoctorWaitSeconds,
  resolveDoctorMaintenanceWaitDeadlineMs,
} from "./doctor-maintenance-foreground.js";

function createDoctorAgentLeaseRefusal(
  env: NodeJS.ProcessEnv,
  cause?: unknown,
  detail = "An agent database is in use.",
): DoctorMaintenanceRefusalError {
  const message = `Doctor could not enter maintenance. ${detail} Stop other OpenClaw processes using this state, then retry the update.`;
  return new DoctorMaintenanceRefusalError(
    message,
    { kind: "deferred", reason: "agent-database-in-use" },
    {
      cause,
      failureFacts: [
        createUpdateFailureFact(
          { check: "doctor", code: "agent-database-lease-active", message },
          env,
        ),
      ],
    },
  );
}

export async function preflightExternalDoctorAgentLease(
  env: NodeJS.ProcessEnv,
  updateRepair: boolean,
): Promise<void> {
  // An external parent may leave the serving Gateway running. Diagnose an
  // active agent lease before that Gateway's lifecycle lock masks it.
  // This negative-only observation grants no maintenance authority: both
  // coordinators and the held-owner lease assertion remain mandatory.
  const { readActiveOpenClawAgentDatabaseLeasesReadOnly } =
    await import("../state/openclaw-agent-db-lease.js");
  let activeAgentLease = false;
  try {
    activeAgentLease = withEngineStoreAdmission(
      () =>
        readActiveOpenClawAgentDatabaseLeasesReadOnly({ env }, openDoctorStateSchemaReadAdmission)
          .length > 0,
    );
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    // Diagnostic failure is not admission. The mandatory held-owner
    // check below still classifies unreadable state and unknown errors.
  }
  if (!activeAgentLease) {
    return;
  }
  if (updateRepair) {
    // Published updaters select this external policy after stopping the Gateway
    // themselves. With no live Gateway, the lease belongs to a transient process
    // that admission waits for without holding state.
    const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
    const gateway = await readActiveGatewayLockIdentity({ env, requireInspection: true }).catch(
      (error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        return "unknown" as const;
      },
    );
    if (gateway === undefined) {
      return;
    }
  }
  throw createDoctorAgentLeaseRefusal(env);
}

/** The caller holds both lifecycle coordinators; this check never opens a state writer. */
export async function assertDoctorAgentLeaseAdmission(env: NodeJS.ProcessEnv): Promise<void> {
  const { assertNoOpenClawAgentDatabaseLeasesReadOnly, OpenClawAgentDatabaseLeaseActiveError } =
    await import("../state/openclaw-agent-db-lease.js");
  try {
    withEngineStoreAdmission(() =>
      assertNoOpenClawAgentDatabaseLeasesReadOnly({ env }, openDoctorStateSchemaReadAdmission),
    );
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

function describeHolders(pids: readonly number[]) {
  // Failure facts are bounded; three PIDs identify the holders well enough.
  const shown = pids.length > 3 ? `${pids.slice(0, 3).join(", ")}, ...` : pids.join(", ");
  return `OpenClaw ${pids.length === 1 ? "process" : "processes"} ${shown}`;
}

/**
 * Admits Doctor maintenance once no other process holds an agent database lease.
 * Update-time Doctor releases everything the attempt acquired and waits until the
 * deadline it shares with state contention: a lease holder must write shared state
 * to close its database, which Doctor's maintenance ownership would refuse.
 */
export async function admitDoctorAgentLeases(params: {
  state: {
    readonly env: NodeJS.ProcessEnv;
    run<T>(operation: () => T): T;
    release(): Promise<Error | undefined>;
  };
  wait: boolean;
  acquire: () => Promise<void>;
  assertCurrent?: () => void;
  signal: AbortSignal;
  log: (message: string) => void;
}): Promise<void> {
  const { readActiveOpenClawAgentDatabaseLeasesReadOnly, OpenClawAgentDatabaseLeaseActiveError } =
    await import("../state/openclaw-agent-db-lease.js");
  // Doctor never waits for a lease it holds itself.
  const foreignHolders = (pids: readonly number[]) =>
    pids.length > 0 && !pids.includes(process.pid) ? pids : undefined;
  const startedAt = performance.now();
  let deadlineMs: number | undefined;
  let holders: readonly number[];
  let waited = false;
  let nextProgressAt = 0;
  for (;;) {
    await params.acquire();
    try {
      await params.state.run(() => assertDoctorAgentLeaseAdmission(params.state.env));
      if (waited) {
        params.log(
          `Agent databases closed after ${formatDoctorWaitSeconds(performance.now() - startedAt)}; continuing Doctor maintenance.`,
        );
      }
      return;
    } catch (error) {
      const cause = error instanceof DoctorMaintenanceRefusalError ? error.cause : undefined;
      const foreign =
        params.wait && cause instanceof OpenClawAgentDatabaseLeaseActiveError
          ? foreignHolders(cause.ownerPids)
          : undefined;
      if (!foreign) {
        throw error;
      }
      holders = foreign;
      deadlineMs ??= await resolveDoctorMaintenanceWaitDeadlineMs(params.state.env);
      if (performance.now() >= deadlineMs) {
        // Keep the lease cause, not the inner refusal, so one failure fact is reported.
        throw waited
          ? createDoctorAgentLeaseRefusal(
              params.state.env,
              cause,
              `Waited ${formatDoctorWaitSeconds(performance.now() - startedAt)}; ${describeHolders(holders)} still ${holders.length === 1 ? "has" : "have"} an agent database open.`,
            )
          : error;
      }
      waited = true;
    }
    // Holding no OpenClaw lock lets the holder record its close.
    const releaseFailure = await params.state.release();
    if (releaseFailure) {
      throw releaseFailure;
    }
    let pollMs = 100;
    for (;;) {
      params.signal.throwIfAborted();
      params.assertCurrent?.();
      const now = performance.now();
      if (now >= deadlineMs) {
        break;
      }
      if (now >= nextProgressAt) {
        params.log(
          nextProgressAt === 0
            ? `Waiting up to ${formatDoctorWaitSeconds(deadlineMs - now)} for ${describeHolders(holders)} to close an agent database before Doctor maintenance. Let it finish, or stop it to continue sooner.`
            : `Still waiting for ${describeHolders(holders)} to close an agent database (${formatDoctorWaitSeconds(now - startedAt)} of ${formatDoctorWaitSeconds(deadlineMs - startedAt)}).`,
        );
        nextProgressAt = now + DOCTOR_MAINTENANCE_WAIT_PROGRESS_INTERVAL_MS;
      }
      await sleep(Math.min(pollMs, deadlineMs - now), params.signal);
      pollMs = Math.min(pollMs * 2, 2_000);
      let live: readonly number[];
      try {
        live = withEngineStoreAdmission(() => [
          ...new Set(
            readActiveOpenClawAgentDatabaseLeasesReadOnly(
              { env: params.state.env },
              openDoctorStateSchemaReadAdmission,
            ).map((row) => row.owner_pid),
          ),
        ]);
      } catch (error) {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        // An observation grants nothing; the held-owner check classifies failures.
        break;
      }
      if (!foreignHolders(live)) {
        break;
      }
      holders = live;
    }
  }
}
