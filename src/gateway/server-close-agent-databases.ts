import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readProcessAgentDatabaseLeasesInWorker } from "../state/openclaw-agent-db-lease-process.read.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");

// Bounds the shutdown diagnostic read; it never holds the stop budget.
const RETAINED_LEASE_READ_TIMEOUT_MS = 2_000;

type MeasureCloseStep = <T>(name: string, run: () => Promise<T> | T) => Promise<T>;

/** One ordered final-owner close step that must settle before agent databases close. */
export type FinalOwnerCloseStep = readonly [name: string, run: () => unknown];

/**
 * Runs the final owner's dependency closes in order, then always releases this process's
 * agent-database leases through their lifecycle owner. A failed step stops the remaining
 * steps but cannot leave leases for the next start to recover as dead-owner rows.
 */
export async function closeFinalOwnerDependenciesThenAgentDatabases(
  steps: readonly FinalOwnerCloseStep[],
  measureCloseStep: MeasureCloseStep,
): Promise<void> {
  let stepFailure: { name: string; error: unknown } | undefined;
  for (const [name, run] of steps) {
    try {
      await measureCloseStep(name, run);
    } catch (error) {
      stepFailure = { name, error };
      shutdownLog.warn(
        `final close step failed: ${name}: ${formatErrorMessage(error)}; releasing agent database leases before reporting it`,
      );
      break;
    }
  }
  // Releasing agent leases still writes shared state; the caller keeps its owner alive.
  let releaseFailure: { error: unknown } | undefined;
  try {
    await measureCloseStep("agent-databases", closeOpenClawAgentDatabasesAsync);
  } catch (error) {
    releaseFailure = { error };
  }
  await reportRetainedAgentDatabaseLeases("final owner close");
  if (stepFailure && releaseFailure) {
    throw new AggregateError(
      [stepFailure.error, releaseFailure.error],
      `Gateway final close failed at ${stepFailure.name} and agent database release`,
      { cause: stepFailure.error },
    );
  }
  if (stepFailure) {
    throw stepFailure.error;
  }
  if (releaseFailure) {
    throw releaseFailure.error;
  }
}

/** Warns about this process's lease rows that survived close; diagnostics never fail shutdown. */
export async function reportRetainedAgentDatabaseLeases(phase: string): Promise<void> {
  try {
    const leases = await readProcessAgentDatabaseLeasesInWorker(
      {},
      AbortSignal.timeout(RETAINED_LEASE_READ_TIMEOUT_MS),
    );
    if (leases.length === 0) {
      return;
    }
    shutdownLog.warn(
      `agent database leases retained after ${phase}: ${leases.length}; the next start recovers them as dead-owner leases`,
      {
        leases: leases.map(({ leaseId, agentId, openedAt }) => ({
          leaseId,
          agentId,
          openedAt: new Date(openedAt).toISOString(),
        })),
      },
    );
  } catch (error) {
    shutdownLog.debug(`agent database lease report unavailable: ${formatErrorMessage(error)}`);
  }
}
