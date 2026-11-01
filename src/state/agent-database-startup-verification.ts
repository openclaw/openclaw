import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertSqliteIntegrityInWorker } from "../infra/sqlite-integrity-worker.js";
import { isTerminalSqliteIntegrityError } from "../infra/sqlite-integrity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createAgentDatabaseInspectionRefusal,
  listAgentDatabaseAdmissionRefusals,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import type { AgentDatabaseStartupVerifier } from "./agent-database-startup-integrity.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "./openclaw-agent-db-lifecycle.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

const log = createSubsystemLogger("state/agent-admission");

/** Full verification observes a WAL snapshot without holding the runtime writer queue.
 * Ordinary writes may proceed until proven corruption revokes the physical owner's
 * admission. Only a completed full check supplies verification age and restart seals.
 */
export const verifyAgentDatabaseStartupIntegrity: AgentDatabaseStartupVerifier = async ({
  agentId,
  paths,
  env,
  signal,
  assertCurrent,
}) => {
  for (const pathname of paths) {
    assertCurrent();
    const execution = captureOpenClawAgentDatabaseExecution({ agentId, path: pathname, env });
    const controller = new AbortController();
    const unobserve = execution.onTerminal((reason) => controller.abort(reason));
    const checkSignal = AbortSignal.any([signal, controller.signal]);
    const assertVerificationCurrent = () => {
      checkSignal.throwIfAborted();
      assertCurrent();
    };
    const startedAt = Date.now();
    try {
      try {
        await assertSqliteIntegrityInWorker(pathname, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, checkSignal);
      } catch (error) {
        assertVerificationCurrent();
        if (!(error instanceof Error) || !isTerminalSqliteIntegrityError(error)) {
          throw error;
        }
        // Publish refusal before yielding to persistence. Worker grants consume the
        // same revocation, so already-open handles cannot continue accepting writes.
        recordAgentDatabaseAdmissions(
          [
            ...listAgentDatabaseAdmissionRefusals({ env }).filter(
              (refusal) => refusal.agentId !== agentId,
            ),
            createAgentDatabaseInspectionRefusal({
              agentId,
              paths: [pathname],
              reason: error.message,
              cause: error,
            }),
          ],
          { env, source: "startup" },
        );
        try {
          recordOpenClawAgentDatabaseOpenFailure(pathname, error);
        } catch (closeError) {
          log.warn("agent database corruption cleanup incomplete", {
            agentId,
            reason: formatErrorMessage(closeError),
          });
        }
        sessionChanges.emit({ all: true, scope: { agentId, topology: true } });
        // The shared-state owner remains available after the agent writer is fenced.
        // Do not use the now-retired agent execution's signal to record its refusal.
        await recordOpenClawDatabaseQuarantineAsync(pathname, error.message, {
          env,
          signal,
          assertCurrent,
        });
        log.error(
          "agent database background integrity check found corruption; run openclaw doctor --fix",
          {
            agentId,
            path: pathname,
            reason: error.message,
          },
        );
        return;
      }
      assertVerificationCurrent();
      await execution.runExisting(
        createSessionWorkerExecutionSource(
          assertVerificationCurrent,
          "Agent database integrity verification lost its startup owner",
        ),
        async (scope) => {
          await scope.execute({
            type: "database.integrityVerified",
            input: { verifiedAt: startedAt },
          });
        },
      );
      log.info("agent database background integrity verification complete", {
        agentId,
        path: pathname,
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      unobserve();
      await execution.release();
    }
  }
};

/** Persist known damage through shared-state custody after the agent writer is fenced. */
async function recordOpenClawDatabaseQuarantineAsync(
  pathname: string,
  reason: string,
  options: { env?: NodeJS.ProcessEnv; assertCurrent: () => void; signal?: AbortSignal },
): Promise<void> {
  options.assertCurrent();
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const recorded = await runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      await scope.execute({ type: "quarantine.record", input: { pathname, reason } });
      return true;
    },
    {
      assertCurrent: options.assertCurrent,
      signal: options.signal,
      existingOnly: true,
      createAdmission: () => ({
        nativeLocations: [
          context.admission.databasePath,
          resolveQuarantineStorePath(context.environment),
        ],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "commit") {
            throw new Error("Database quarantine requires its corruption-recording admission");
          }
          context.admission.assertCurrent();
          options.signal?.throwIfAborted();
          options.assertCurrent();
          grant();
        }),
      }),
    },
  );
  if (!recorded) {
    throw new Error("Shared-state owner unavailable while recording database corruption");
  }
}
