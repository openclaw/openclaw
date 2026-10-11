import { readTranscriptMessageIdempotencyKey } from "../../gateway/session-transcript-entry-message.js";
import {
  prepareTranscriptCommitFromSnapshot,
  isCommittedAgentMessage,
} from "../../gateway/worker-environments/transcript-commit-policy.js";
import type { ApplyTranscriptCommitResult } from "../../gateway/worker-environments/transcript-commit.types.js";
import { createWorkerLedgerInputValidation } from "../../gateway/worker-environments/worker-ledger-validation.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import { createSessionActorMemoryMessages } from "./session-actor-memory-messages.js";
import type { SessionActorMemoryReportsWrites } from "./session-actor-memory-reports-contract.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";

const validation = createWorkerLedgerInputValidation("Worker transcript commit");
type Operation = SessionActorMemoryReportsWrites["session.workerTranscript.commit"];
export function commitSessionActorMemoryWorkerTranscript(
  context: SessionActorMemoryStorageContext,
  input: Operation["input"],
): Operation["output"] {
  const { state, agentId } = context;
  const { scope, receipt } = input;
  const runEpoch = validation.integer(receipt.runEpoch, "run epoch");
  const seq = validation.integer(receipt.seq, "sequence", 1);
  const environmentId = validation.required(receipt.environmentId, "environment id");
  const requestHash = validation.requestHash(receipt.requestHash);
  if (validation.required(receipt.sessionId, "session id") !== scope.sessionId) {
    throw new Error("Transcript receipt belongs to another session");
  }
  const current = state.workerTranscriptCommits.get(runEpoch);
  const prior = current?.receipts.get(seq);
  const rejected = (): Operation["output"] => ({
    result: { ok: false, reason: "invalid-batch" },
    outcome: { ok: false, reason: "invalid-batch" },
    replayed: false,
  });
  if (current && current.environmentId !== environmentId) {
    return rejected();
  }
  if (prior) {
    if (prior.requestHash !== requestHash) {
      return rejected();
    }
    return {
      result: { ok: true, messages: [], lifecycleRevision: state.hot.entry?.lifecycleRevision },
      outcome: prior.outcome,
      replayed: true,
    };
  }
  if (seq !== (current?.nextSeq ?? 1)) {
    return rejected();
  }
  const apply = (): ApplyTranscriptCommitResult => {
    const entry = state.hot.entry;
    if (!entry) {
      return { ok: false, reason: "session-not-attached" };
    }
    const events = createSessionActorMemoryEvents(context);
    const { appendMessage } = createSessionActorMemoryMessages(context, events);
    const { batch, preparedMessages } = input;
    const preparedInput = {
      ...batch,
      scope: {
        ...scope,
        agentId,
        sessionKey: scope.sessionKey ?? state.hot.target.sessionKey,
        storePath: scope.storePath ?? state.hot.target.storePath,
      },
    };
    const plan = prepareTranscriptCommitFromSnapshot(preparedInput, entry, () => ({
      events: state.events.map((row) => row.event),
      version: events.version(),
    }));
    if (!plan.result.ok || plan.result.messages.length === batch.messages.length) {
      return plan.result;
    }
    const recovered = plan.result.messages.length;
    const fresh = preparedMessages.slice(recovered);
    if (
      preparedMessages.length !== batch.messages.length ||
      !fresh.every(
        (message, index) =>
          isCommittedAgentMessage(message) &&
          readTranscriptMessageIdempotencyKey(message)?.trim() ===
            readTranscriptMessageIdempotencyKey(batch.messages[recovered + index])?.trim(),
      )
    ) {
      return { ok: false, reason: "invalid-batch" };
    }
    let parentId = plan.parentId;
    let messageSeq = plan.nextMessageSeq;
    const messages = [...plan.result.messages];
    for (const message of fresh) {
      const result = appendMessage({
        message,
        cwd: batch.cwd,
        parentId,
        appendIntent: "active-branch",
        idempotencyLookup: "caller-checked",
      }).result;
      if (!result?.appended || !isCommittedAgentMessage(result.message)) {
        throw new Error("Worker transcript message was not persisted");
      }
      parentId = result.messageId;
      messages.push({
        appended: true,
        message: result.message,
        messageId: result.messageId,
        messageSeq: ++messageSeq,
      });
    }
    state.hot.entry = {
      ...state.hot.entry!,
      updatedAt: Math.max(entry.updatedAt ?? 0, Date.now()),
    };
    return { ...plan.result, messages };
  };
  const result = apply();
  const entryIds = result.ok ? result.messages.map((message) => message.messageId) : [];
  const newLeafId = entryIds.at(-1);
  const outcome: Operation["output"]["outcome"] = !result.ok
    ? result
    : newLeafId && entryIds.length === input.batch.messages.length
      ? { ok: true, result: { entryIds, newLeafId } }
      : { ok: false, reason: "invalid-batch" };
  const ledger = current
    ? { ...current, receipts: new Map(current.receipts) }
    : { environmentId, nextSeq: 1, receipts: new Map() };
  ledger.receipts.set(seq, { requestHash, outcome });
  ledger.nextSeq = seq + 1;
  state.workerTranscriptCommits.set(runEpoch, ledger);
  return { result, outcome, replayed: false };
}
