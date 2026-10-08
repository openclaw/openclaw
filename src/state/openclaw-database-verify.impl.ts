import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  confirmOpenClawAgentDatabaseIntegrity,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import type { DatabaseVerifyWorkerLifetime } from "./openclaw-database-verify-client.js";
import type {
  OpenClawDatabaseVerifyResult,
  OpenClawDatabaseVerifyTarget,
} from "./openclaw-database-verify.worker.js";
import { recordOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import {
  confirmOpenClawStateDatabaseIntegrity,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db.js";

const log = createSubsystemLogger("state/database-verify");

/** Reconfirm worker failures on live owners before quarantine and latching. */
export async function applyOpenClawDatabaseVerificationResults(options: {
  env: NodeJS.ProcessEnv;
  results: readonly OpenClawDatabaseVerifyResult[];
  targets: readonly OpenClawDatabaseVerifyTarget[];
  workerLifetime?: DatabaseVerifyWorkerLifetime;
  onVerified?: (pathname: string) => Promise<boolean | undefined>;
}): Promise<void> {
  const targetByPath = new Map(options.targets.map((target) => [target.path, target]));

  // A healthy writer's queue must never delay quarantine of another database.
  for (const result of options.results.toSorted(
    (left, right) => Number(left.ok) - Number(right.ok),
  )) {
    options.workerLifetime?.assertCurrent?.();
    const target = targetByPath.get(result.path);
    if (!target) {
      continue;
    }
    const details = {
      kind: target.kind,
      label: target.label,
      path: result.path,
      check: target.check,
    };
    if (result.ok) {
      let durableVerification: boolean | undefined;
      try {
        durableVerification = await options.onVerified?.(result.path);
      } catch (error) {
        options.workerLifetime?.assertCurrent?.();
        durableVerification = false;
        log.warn("database integrity verification proof was not retained", {
          ...details,
          error: String(error),
        });
      }
      options.workerLifetime?.assertCurrent?.();
      log.info("database integrity verification passed", { ...details, durableVerification });
      continue;
    }
    if (!result.terminal) {
      log.warn("database integrity verification was inconclusive", {
        ...details,
        error: result.error,
      });
      continue;
    }
    const confirmation = await (target.kind === "state"
      ? confirmOpenClawStateDatabaseIntegrity(result.path)
      : confirmOpenClawAgentDatabaseIntegrity(result.path, options.workerLifetime));
    options.workerLifetime?.assertCurrent?.();
    if (confirmation.status === "healthy") {
      log.info("discarding stale database integrity verification result", details);
      continue;
    }
    if (!confirmation.terminal) {
      log.warn("database integrity verification was inconclusive", {
        ...details,
        error: confirmation.error.message,
      });
      continue;
    }
    const recordFailure =
      target.kind === "state"
        ? recordOpenClawStateDatabaseOpenFailure
        : recordOpenClawAgentDatabaseOpenFailure;
    const latched = recordFailure(result.path, confirmation.error, confirmation.generation);
    if (!latched) {
      log.info("discarding database integrity result after database generation changed", details);
      continue;
    }
    if (target.kind === "agent") {
      // Confirmation awaited drainage; retire any actor admitted before the terminal latch.
      await closeOpenClawAgentDatabaseByPathAsync(result.path);
    }
    const recorded = recordOpenClawDatabaseQuarantine({
      env: options.env,
      generation: confirmation.generation,
      kind: target.kind,
      path: result.path,
      reason: confirmation.error.message,
    });
    if (!recorded) {
      log.error("failed to persist database quarantine; quarantine is process-local", {
        kind: target.kind,
        path: result.path,
      });
    }
    log.error("database integrity verification failed", {
      ...details,
      error: confirmation.error.message,
    });
  }
}
