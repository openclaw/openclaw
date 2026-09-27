// Gateway startup-migration readiness refusals shared by doctor config preflight.
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isTerminalSqliteIntegrityError } from "../infra/sqlite-integrity.js";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { isSqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { ExitError } from "../runtime.js";
import { isAgentDatabaseOwnershipMismatchError } from "../state/agent-database-admission.js";

/** Admission, final reads and in-process restarts share the same terminal refusal facts. */
export function isStartupConfigRefusal(error: unknown): boolean {
  // Only explicit maintenance or a known storage/ownership refusal can park a managed Gateway.
  // Unavailable reads, scratch allocation, and cleanup retain their ordinary failure.
  return (
    Boolean(findStartupMaintenanceRequiredError(error)) ||
    isAgentDatabaseOwnershipMismatchError(error) ||
    collectNestedErrorCandidates(error).some(
      (failure) =>
        failure instanceof Error &&
        (failure instanceof OpenClawStateOwnershipError ||
          isSqliteSchemaMismatchError(failure) ||
          isTerminalSqliteIntegrityError(failure) ||
          failure.name === "SqliteRepairableForeignKeyError"),
    )
  );
}

/** Preserve explicit exits and operational failures after the caller's cleanup has settled. */
export function rethrowStartupConfigFailure(error: unknown): never {
  if (error instanceof ExitError || !isStartupConfigRefusal(error)) {
    throw error;
  }
  return throwStartupMigrationRefusal(formatErrorMessage(error), error);
}

function throwStartupMigrationRefusal(message: string, cause?: unknown): never {
  // ExitError bypasses entry.ts's generic failure formatter, so report the owned reason here.
  console.error(message);
  throw Object.assign(new ExitError(78, message), { cause });
}

export function throwStartupMigrationGuardRejected(): never {
  throw new Error(
    "OpenClaw startup migrations were skipped because the selected config changed during startup; refusing to report the gateway ready. Retry startup so the new config can be validated.",
  );
}

export function throwStartupMigrationIdentityChanged(reason?: string): never {
  throwStartupMigrationRefusal(
    `OpenClaw migration inputs changed during startup${reason ? ` (${reason})` : ""}; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.`,
  );
}

/**
 * A gateway startup that will refuse readiness must stay side-effect-free: a live owner of
 * this state directory means every pending startup write (config-health recovery, sidecar
 * quarantine, automatic migrations) would mutate its files before the runtime lock refuses.
 * Probe-only: the runtime lock stays owned by the gateway run loop's restart lifecycle.
 * Test runs skip the probe like acquireGatewayLock does (locks are disabled under Vitest).
 * Returns the refusal message so each mutation boundary can report through its own runtime.
 */
async function describeLiveGatewayOwnerStartupBlocker(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (env.VITEST || env.NODE_ENV === "test") {
    return undefined;
  }
  const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
  const activeGateway = await readActiveGatewayLockIdentity({ env });
  if (!activeGateway) {
    return undefined;
  }
  return `Another gateway (pid ${activeGateway.pid}) already owns this state directory; refusing to run automatic startup migrations or report the gateway ready. Stop it with "openclaw gateway stop" (or select a different OPENCLAW_STATE_DIR), then retry startup.`;
}

export async function refuseStartupMigrationsForLiveGatewayOwner(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const blocker = await describeLiveGatewayOwnerStartupBlocker(env);
  if (blocker) {
    throwStartupMigrationRefusal(blocker);
  }
}
