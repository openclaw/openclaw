import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type { SessionEntryLifecycleCommit } from "./session-accessor.sqlite-lifecycle-commit.js";
import {
  prepareSessionEntryReplacementPublication,
  type SessionEntryReplacementCommit,
  type SessionEntryReplacementCommitted,
} from "./session-accessor.sqlite-replacement-state.js";

type SessionEntryWorkerDatabaseOptions = OpenClawAgentDatabaseOptions & { path: string };

async function withSessionEntryWorker<T>(
  options: SessionEntryWorkerDatabaseOptions,
  databaseIdentity: string | undefined,
  assertCurrent: () => void,
  run: (
    execution: OpenClawAgentDatabaseExecution,
    source: AgentDatabaseRequestExecutionSource,
  ) => Promise<T>,
  onCommit?: (
    admission: SqliteWorkerOperationAdmission,
    retained: RetainedWorkerTransactionAdmission,
    facts: unknown,
  ) => void,
): Promise<T> {
  const execution = captureOpenClawAgentDatabaseExecution(
    options,
    databaseIdentity
      ? {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: databaseIdentity,
            nativeLocation: options.path,
          },
        }
      : {},
  );
  const assertHeld = () => {
    execution.assertCurrent();
    assertCurrent();
  };
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: assertHeld,
    createAdmission(binding) {
      return (retained) => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertHeld();
          if (request.stage === "commit") {
            onCommit?.(admission, retained, request.facts);
          }
          if (!grant()) {
            throw new Error("Session replacement authority expired");
          }
        });
        return { nativeLocations: binding.nativeLocations, admission };
      };
    },
  };
  try {
    return await runOpenClawAgentWorkerWrite(options, () => run(execution, source));
  } finally {
    await execution.release();
  }
}

export function prepareSessionEntryMutationDatabase(
  options: SessionEntryWorkerDatabaseOptions,
  assertCurrent: () => void,
): Promise<void> {
  return withSessionEntryWorker(options, undefined, assertCurrent, (execution, source) =>
    execution.prepare(source),
  );
}

async function commitSessionEntryMutationInWorker<TResult extends SessionEntryReplacementCommitted>(
  options: SessionEntryWorkerDatabaseOptions,
  publicationAgentId: string,
  databaseIdentity: string,
  assertCurrent: () => void,
  run: (
    execution: OpenClawAgentDatabaseExecution,
    source: AgentDatabaseRequestExecutionSource,
  ) => Promise<TResult | undefined>,
  onCommitted?: () => void,
) {
  const publication = retainSessionEntryWorkerPublication({
    agentId: publicationAgentId,
    storePath: options.path,
    databaseIdentity,
  });
  let committed: TResult | undefined;
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  try {
    return await withSessionEntryWorker(
      options,
      databaseIdentity,
      assertCurrent,
      async (execution, source) => {
        const result = await run(execution, source);
        if (!result) {
          throw new Error("Session database disappeared before replacement");
        }
        committed = result;
        return result;
      },
      (admission, retained, facts) => {
        if (
          !isRecord(facts) ||
          !isRecord(facts.publication) ||
          facts.publication.kind !== "session-entry-replacements" ||
          !Array.isArray(facts.publication.changedKeys) ||
          !facts.publication.changedKeys.every((key): key is string => typeof key === "string") ||
          !Array.isArray(facts.publication.membershipInvalidatedKeys) ||
          !facts.publication.membershipInvalidatedKeys.every(
            (key): key is string => typeof key === "string",
          )
        ) {
          throw new Error("Session replacement commit omitted its publication keys");
        }
        admitted = { admission, retained };
        publication.begin(
          facts.publication.changedKeys,
          facts.publication.membershipInvalidatedKeys,
        );
      },
    );
  } finally {
    if (admitted) {
      const settlement = await admitted.retained.settled;
      const facts = admitted.admission.committed?.facts;
      let receipt: SessionEntryReplacementPublication | undefined;
      if (isRecord(facts) && facts.kind === "session-entry-replacements") {
        // SAFETY: This retained command's paired native kernel owns the tagged publication receipt.
        receipt = facts as SessionEntryReplacementPublication;
      } else if (committed) {
        receipt = prepareSessionEntryReplacementPublication(committed);
      }
      try {
        if (receipt) {
          onCommitted?.();
        }
      } finally {
        const published = publication.settle(receipt, settlement.kind === "unknown");
        if (published) {
          for (const sessionKey of published.progressResetKeys ?? []) {
            emitSessionLifecycleEvent({
              agentId: publicationAgentId,
              sessionKey,
              reason: "progress-card-reset",
            });
          }
          publishCommittedSessionIdentity(
            publicationAgentId,
            published.previous,
            published.current,
          );
        }
      }
    }
  }
}

export function commitSessionEntryReplacementsInWorker(
  options: SessionEntryWorkerDatabaseOptions,
  publicationAgentId: string,
  databaseIdentity: string,
  input: SessionEntryReplacementCommit,
  assertCurrent: () => void,
) {
  return commitSessionEntryMutationInWorker(
    options,
    publicationAgentId,
    databaseIdentity,
    assertCurrent,
    (execution, source) =>
      execution.runExisting(source, (worker) =>
        worker.execute({ type: "session.entries.replace", input }),
      ),
  );
}

export function commitSessionEntryLifecycleInWorker(
  options: SessionEntryWorkerDatabaseOptions,
  databaseIdentity: string,
  input: SessionEntryLifecycleCommit,
  assertCurrent: () => void,
  onCommitted?: () => void,
) {
  return commitSessionEntryMutationInWorker(
    options,
    input.scope.agentId,
    databaseIdentity,
    assertCurrent,
    (execution, source) =>
      execution.runExisting(source, (worker) =>
        worker.execute({ type: "session.entries.lifecycle", input }),
      ),
    onCommitted,
  );
}
