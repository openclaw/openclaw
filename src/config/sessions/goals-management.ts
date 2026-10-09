import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import type { SessionGoalManagementInput } from "./goals-operations.js";
import type {
  SessionGoalManagementCandidate,
  SessionGoalManagementOperations,
  SessionGoalManagementResult,
} from "./goals-operations.worker.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourceValidation,
} from "./session-source-authority.js";

export async function mutateSessionGoalInWorker(
  database: OpenClawAgentDatabaseOptions & { path: string },
  agentId: string,
  execution: OpenClawAgentDatabaseExecution,
  input: SessionGoalManagementInput,
  assertion: SessionSourceAssertion | undefined,
  native: (assertCaptured: () => void) => Promise<SessionGoalManagementResult>,
): Promise<SessionGoalManagementResult> {
  let identity: ReturnType<typeof readDatabasePathIdentitySync>;
  let source: PreparedSessionSourceAuthority;
  try {
    execution.assertCurrent();
    identity = readDatabasePathIdentitySync(database.path);
    source = await prepareSessionSourceAuthority(assertion);
  } catch (error) {
    await releaseSessionSourceAuthorities([execution], [error]);
    throw error;
  }
  const release = () => releaseSessionSourceAuthorities([execution, source]);
  if (
    source.nativeSource ||
    source.checks.some(
      ({ predicate }) =>
        typeof predicate.source.databaseIdentity !== "string" ||
        `file:${predicate.source.databaseIdentity}` !== identity.key,
    )
  ) {
    try {
      // Cross-store and opaque SDK guards retain event-loop atomicity with native writes.
      return await native(() => execution.assertCurrent());
    } finally {
      await release();
    }
  }
  return runSessionEntryWorkerOperation<
    SessionGoalManagementCandidate,
    SessionGoalManagementResult
  >({
    database,
    retainedExecution: execution,
    agentId,
    candidateKind: "session-goal-management",
    onTransactionFacts(facts) {
      if (isRecord(facts) && facts.kind === "session-entry-patch-validated") {
        // SAFETY: The paired goal kernel supplies its transaction's matched source indices.
        acceptSessionSourceValidation(source, facts.sourceValidation as SessionSourceValidation);
        source.assertCurrent();
        return true;
      }
      return false;
    },
    assertCurrent: source.assertCurrent,
    releaseSource: release,
    assertCandidate(candidate) {
      if (candidate.refusedSource) {
        const refused = candidate.refusedSource;
        source.checks[refused.index]?.refuse(refused.facts);
        throw new Error("Goal source refusal omitted its authority assertion");
      }
    },
    run: (worker, commit) =>
      commit(() =>
        executeOpenClawAgentWorkerPublication<
          SessionGoalManagementOperations,
          "session.goal.mutate"
        >(worker, {
          id: randomUUID(),
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionGoalOperations).href,
          input: { agentId: database.agentId },
          command: {
            type: "session.goal.mutate",
            input: { ...input, sources: source.checks.map(({ predicate }) => predicate) },
          },
        }),
      ),
    // Goal management cannot change session identity. The entry publication still settles in FIFO.
    onCommitted: (candidate) => {
      if (candidate.refusedSource) {
        throw new Error("Refused Goal source reached publication");
      }
      return candidate.result;
    },
  });
}
