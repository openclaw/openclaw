import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
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
import {
  prepareSessionEntryReplacementPublication,
  type SessionEntryReplacementCommit,
  type SessionEntryReplacementCommitted,
} from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";

type ReplacementDatabaseOptions = OpenClawAgentDatabaseOptions & { path: string };

export async function withSessionEntryWorker<T>(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string | undefined,
  assertCurrent: () => void,
  run: (
    execution: OpenClawAgentDatabaseExecution,
    source: AgentDatabaseRequestExecutionSource,
    context: SessionEntryCommitContext,
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
  let assertNativeCurrent: (() => void) | undefined;
  const context: SessionEntryCommitContext = {
    env: Object.freeze({ ...(options.env ?? process.env) }),
    assertCurrent() {
      execution.assertCurrent();
      assertNativeCurrent?.();
    },
  };
  const assertHeld = () => {
    execution.assertCurrent();
    assertCurrent();
  };
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: assertHeld,
    createAdmission(binding) {
      assertNativeCurrent = () => binding.assertCurrent();
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
    return await runOpenClawAgentWorkerWrite(options, () => run(execution, source, context));
  } finally {
    await execution.release();
  }
}

export function prepareSessionEntryReplacementDatabase(
  options: ReplacementDatabaseOptions,
  assertCurrent: () => void,
): Promise<void> {
  return withSessionEntryWorker(options, undefined, assertCurrent, (execution, source) =>
    execution.prepare(source),
  );
}

export async function initializeSessionTranscriptInWorker(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string,
  input: { sessionKey: string; sessionId: string; cwd?: string },
  assertCurrent: () => void,
): Promise<void> {
  await withSessionEntryWorker(
    options,
    databaseIdentity,
    assertCurrent,
    async (execution, source) => {
      const initialized = await execution.runExisting(source, async (worker) => {
        await worker.execute({ type: "session.transcript.initialize", input });
        return true;
      });
      if (!initialized) {
        throw new Error("Session database disappeared before transcript initialization");
      }
    },
  );
}

export async function commitSessionEntryReplacementsInWorker(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string,
  input: SessionEntryReplacementCommit,
  assertCurrent: () => void,
  lifecycle: {
    identityAgentId: string;
    afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
    onLifecycleCommitted?: () => void;
  },
) {
  const publication = retainSessionEntryWorkerPublication({
    agentId: options.agentId,
    storePath: options.path,
    databaseIdentity,
  });
  let committed: SessionEntryReplacementCommitted | undefined;
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  const settle = async () => {
    if (!admitted) {
      return;
    }
    const settlement = await admitted.retained.settled;
    const facts = admitted.admission.committed?.facts;
    let receipt: SessionEntryReplacementPublication | undefined;
    if (isRecord(facts) && facts.kind === "session-entry-replacements") {
      // SAFETY: This retained command's paired native kernel owns the tagged publication receipt.
      receipt = facts as SessionEntryReplacementPublication;
    } else if (committed) {
      receipt = prepareSessionEntryReplacementPublication(committed);
    }
    if (receipt) {
      lifecycle.onLifecycleCommitted?.();
    }
    const published = publication.settle(receipt, settlement.kind === "unknown");
    if (published) {
      publishCommittedSessionIdentity(
        lifecycle.identityAgentId,
        published.previous,
        published.current,
      );
    }
  };
  return await withSessionEntryWorker(
    options,
    databaseIdentity,
    assertCurrent,
    (execution, source, context) =>
      execution
        .runExisting(source, async (worker) => {
          try {
            committed = await worker.execute({ type: "session.entries.replace", input });
          } finally {
            // Retain the executing broker scope and FIFO writer through publication settlement.
            // Close joins this callback; a delayed result cannot borrow a successor owner.
            await settle();
          }
          await lifecycle.afterCommitted?.(context);
          return committed;
        })
        .then((result) => {
          if (!result) {
            throw new Error("Session database disappeared before replacement");
          }
          return result;
        }),
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
      publication.begin(facts.publication.changedKeys, facts.publication.membershipInvalidatedKeys);
    },
  );
}
