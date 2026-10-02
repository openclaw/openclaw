import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type { WorkerTranscriptCommitParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  loadSessionEntry,
  publishTranscriptUpdate,
  withTranscriptWriteTransaction,
} from "../../config/sessions/session-accessor.js";
import { publishSessionEntryWorkerMetadataInvalidation } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { redactTranscriptMessageForStorage } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { restoreSessionColdTranscript } from "../../config/sessions/session-cold-storage.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  attachSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { prepareWorkerTurnTranscriptMessage } from "./placement-turn-claim-events.js";
import type {
  WorkerTranscriptCommitInput,
  WorkerTranscriptCommitOutcome,
  WorkerTranscriptCommitStore,
} from "./transcript-commit-store.js";
import type {
  WorkerTranscriptCommitApplication,
  WorkerTranscriptCommitterOptions,
} from "./transcript-commit.js";
import {
  applyPreparedTranscriptCommit,
  isCommittedAgentMessage,
  prepareTranscriptCommit,
  type ApplyTranscriptCommitResult,
  type CommittedAgentMessage,
  type TranscriptCommitInput,
} from "./transcript-commit.kernel.js";
import type { WorkerTranscriptOperations } from "./transcript-commit.worker.js";

const log = createSubsystemLogger("gateway/worker-transcript");
const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.workerTranscriptCommit);

function requestHash(request: WorkerTranscriptCommitParams): string {
  return createHash("sha256")
    .update(
      stableStringify({
        baseLeafId: request.baseLeafId,
        messages: request.messages,
      }),
    )
    .digest("hex");
}

function messageIdempotencyKey(params: {
  sessionId: string;
  runEpoch: number;
  seq: number;
  index: number;
}): string {
  const digest = createHash("sha256")
    .update([params.sessionId, params.runEpoch, params.seq, params.index].join("\0"))
    .digest("base64url");
  return `worker-commit-${digest}`;
}

async function applyWorkerTranscriptCommit(params: {
  assertCurrent: () => undefined;
  config: OpenClawConfig;
  identity: WorkerConnectionIdentity;
  messages: readonly CommittedAgentMessage[];
  recoverPersistedBatch: boolean;
  requestedBaseLeafId: string | null;
  runId: string | null;
  sessionId: string;
  target: BoundAgentRunSessionTarget;
  lifecycleRevision: string | undefined;
}): Promise<ApplyTranscriptCommitResult> {
  const target = withOwnedSessionTranscriptWriterFence({
    ...captureSessionTranscriptTargetBinding(params.target),
    expectedLifecycleRevision: params.target.expectedLifecycleRevision,
    expectedWriterRunId: params.target.expectedWriterRunId,
  });
  const options = toDatabaseOptions(resolveSqliteTranscriptScope(target));
  const assertOwned = captureOwnedTranscriptWriteAssertion(target);
  const assertCurrent = () => {
    params.assertCurrent();
    assertOwned();
  };
  const redactedMessages = params.messages.map((message) =>
    attachSessionTranscriptRunId(redactTranscriptMessage(message, params.config), params.runId),
  );
  const { env: _env, ...scope } = target;
  const input: TranscriptCommitInput = {
    scope,
    messages: params.messages,
    lifecycleRevision: params.lifecycleRevision,
    requestedBaseLeafId: params.requestedBaseLeafId,
    recoverPersistedBatch: params.recoverPersistedBatch,
    cwd: process.cwd(),
  };
  const prepareFresh = (recoveredCount: number) => {
    const messages = redactedMessages.slice(recoveredCount);
    if (!messages.every(isCommittedAgentMessage)) {
      return undefined;
    }
    return messages.map((message) => {
      if (message.role === "assistant") {
        Object.assign(message, prepareWorkerTurnTranscriptMessage(params.identity, message));
        applyAssistantDeliveryDirectives(message);
      }
      return redactTranscriptMessageForStorage(message, { config: params.config });
    });
  };
  let applied: ApplyTranscriptCommitResult;
  if (isIncognitoSessionKey(target.sessionKey)) {
    // Incognito retains its process-held database until the worker-owned cutover.
    let projectionNeedsReconcile = false;
    applied = await withTranscriptWriteTransaction(target, (): ApplyTranscriptCommitResult => {
      assertCurrent();
      const nativeInput = { ...input, scope: target };
      const plan = prepareTranscriptCommit(nativeInput);
      if (!plan.result.ok || plan.result.messages.length === input.messages.length) {
        return plan.result;
      }
      const messages = prepareFresh(plan.result.messages.length);
      if (!messages) {
        return { ok: false, reason: "invalid-batch" };
      }
      const result = applyPreparedTranscriptCommit(nativeInput, plan, messages, () => {
        projectionNeedsReconcile = true;
      });
      assertCurrent();
      return result;
    });
    if (projectionNeedsReconcile) {
      startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: target.sessionId });
    }
  } else {
    await restoreSessionColdTranscript(target);
    assertCurrent();
    const execution = captureOpenClawAgentDatabaseExecution(options);
    let worker:
      | Awaited<ReturnType<typeof openOpenClawAgentSqliteWorkerStore<WorkerTranscriptOperations>>>
      | undefined;
    let outcome: { ok: true; value: ApplyTranscriptCommitResult } | { ok: false; error: unknown };
    try {
      worker = await openOpenClawAgentSqliteWorkerStore<WorkerTranscriptOperations>(
        options,
        { execution },
        { moduleUrl, input: undefined },
      );
      const value = await worker.run(async (writer): Promise<ApplyTranscriptCommitResult> => {
        const plan = await writer.execute({
          type: "transcript.prepare",
          input: { ...input, scope: { ...scope, storePath: execution.path } },
        });
        assertCurrent();
        if (!plan.ok || plan.messages.length === input.messages.length) {
          return plan;
        }
        const messages = prepareFresh(plan.messages.length);
        if (!messages) {
          return { ok: false, reason: "invalid-batch" };
        }
        assertCurrent();
        const databaseIdentity = execution.fileIdentity?.physicalIdentity;
        if (!databaseIdentity) {
          throw new Error("Worker transcript has no prepared database identity");
        }
        const committed = await writer.execute({ type: "transcript.commit", input: { messages } });
        if (committed.result.ok && committed.result.messages.some((message) => message.appended)) {
          publishSessionEntryWorkerMetadataInvalidation({
            agentId: target.agentId,
            storePath: execution.path,
            databaseIdentity,
            sessionKey: target.sessionKey,
          });
        }
        if (committed.projectionNeedsReconcile) {
          startSessionTranscriptIndexReconcile({
            ...options,
            preferredSessionId: target.sessionId,
          });
        }
        return committed.result;
      }, assertCurrent);
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const cleanupFailures: unknown[] = [];
    try {
      await worker?.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await execution.release();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      const cleanupError = createSqliteLifecycleAggregateError(
        [...(outcome.ok ? [] : [outcome.error]), ...cleanupFailures],
        "Worker transcript operation and cleanup failed",
        outcome.ok ? cleanupFailures[0] : (outcome.error ?? cleanupFailures[0]),
      );
      if (!outcome.ok) {
        throw cleanupError;
      }
      try {
        log.warn(
          `Worker transcript completed before cleanup failed: ${formatErrorMessage(cleanupError)}`,
        );
      } catch {
        // A diagnostic failure cannot erase the committed batch receipt.
      }
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    applied = outcome.value;
  }
  if (!applied.ok) {
    return applied;
  }

  for (const message of applied.messages) {
    if (!message.appended) {
      continue;
    }
    const runId = resolveTerminalAssistantTranscriptRunId(message.message, params.runId);
    await publishTranscriptUpdate(params.target, {
      lifecycleRevision: params.lifecycleRevision,
      message: message.message,
      messageId: message.messageId,
      messageSeq: message.messageSeq,
      ...(runId ? { runId } : {}),
    });
  }
  return applied;
}

export async function commitWorkerTranscript(
  options: WorkerTranscriptCommitterOptions,
  store: WorkerTranscriptCommitStore,
  sessionId: string,
  params: Parameters<WorkerTranscriptCommitApplication>[0],
): Promise<WorkerTranscriptCommitOutcome> {
  const input: WorkerTranscriptCommitInput = {
    environmentId: params.identity.environmentId,
    sessionId,
    runEpoch: params.request.runEpoch,
    seq: params.request.seq,
    requestHash: requestHash(params.request),
  };
  params.assertCurrent();
  const started = store.begin(input);
  if (started.kind === "replay") {
    return started.outcome;
  }
  if (started.kind === "rejected") {
    return { ok: false, reason: "invalid-batch" };
  }

  const config = options.getConfig();
  const target = withOwnedSessionTranscriptWriterFence({
    ...captureSessionTranscriptTargetBinding(params.sessionTarget),
    expectedLifecycleRevision: params.sessionTarget.expectedLifecycleRevision,
    expectedWriterRunId: params.sessionTarget.expectedWriterRunId,
  });
  // Ingress validated the closed schema; clone every admitted field before transcript redaction.
  const messages = params.request.messages.map((message, index) => ({
    ...structuredClone(message),
    idempotencyKey: messageIdempotencyKey({
      sessionId,
      runEpoch: params.request.runEpoch,
      seq: params.request.seq,
      index,
    }),
  }));
  const requestedBaseLeafId = params.request.baseLeafId;
  let entry: InternalSessionEntry | undefined;
  try {
    const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptScope(target));
    const entryResult = isIncognitoSessionKey(target.sessionKey)
      ? { ok: true as const, value: loadSessionEntry(target) }
      : await withSessionHistoryWorkerDatabase(databaseOptions, (owner) =>
          owner.readEntryResult({
            scope: {
              ...target,
              storePath: resolveOpenClawAgentSqlitePath(databaseOptions),
              env: databaseOptions.env,
              databaseAgentId: databaseOptions.agentId,
            },
          }),
        );
    params.assertCurrent();
    if (!entryResult.ok) {
      throw entryResult.error;
    }
    entry = entryResult.value;
  } catch (error) {
    // No transcript command has been dispatched while the initial entry read is pending.
    if (started.kind === "claimed") {
      store.discardUncommitted(input);
    }
    throw error;
  }
  if (!entry || entry.sessionId !== sessionId) {
    return store.complete({
      ...input,
      outcome: { ok: false, reason: "session-not-attached" },
    });
  }
  let authorityFailure: { error: unknown } | undefined;
  let applied: ApplyTranscriptCommitResult;
  try {
    applied = await applyWorkerTranscriptCommit({
      assertCurrent: () => {
        try {
          params.assertCurrent();
        } catch (error) {
          authorityFailure = { error };
          throw error;
        }
      },
      config,
      identity: params.identity,
      messages,
      recoverPersistedBatch: started.kind === "recover",
      requestedBaseLeafId,
      runId: params.identity.runId,
      sessionId,
      target,
      lifecycleRevision: target.expectedLifecycleRevision ?? entry.lifecycleRevision,
    });
  } catch (error) {
    // A callback refusal has rolled back the agent transaction. Free only
    // this invocation's fresh reservation; unknown commit outcomes must recover.
    if (started.kind === "claimed" && authorityFailure && authorityFailure.error === error) {
      store.discardUncommitted(input);
    }
    throw error;
  }
  if (!applied.ok) {
    return store.complete({ ...input, outcome: { ok: false, reason: applied.reason } });
  }
  const entryIds = applied.messages.map((message) => message.messageId);
  const newLeafId = entryIds.at(-1);
  if (entryIds.length !== messages.length || !newLeafId) {
    return store.complete({
      ...input,
      outcome: { ok: false, reason: "invalid-batch" },
    });
  }
  return store.complete({
    ...input,
    outcome: { ok: true, result: { entryIds, newLeafId } },
  });
}
