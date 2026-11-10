import { addAbortListener } from "node:events";
import type { BoundedConversation } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  SessionCompactionSourceRequest,
  SessionCompactionSourceConsumer,
  SessionCompactionSourceCommand,
  SessionCompactionSourceReply,
} from "./session-compaction-source.types.js";
import type { SessionHistoryWorkerRequestRunner } from "./session-transcript-worker.types.js";

/** Budgeted text exchanges retain the read snapshot only through summary generation. */
export async function withSessionCompactionSource(
  runRequest: SessionHistoryWorkerRequestRunner,
  input: Omit<SessionCompactionSourceRequest, "kind" | "database">,
  consume: SessionCompactionSourceConsumer,
  signal?: AbortSignal,
  timeoutMs = 600_000,
) {
  let command = createDeferredCore<SessionCompactionSourceCommand>();
  let pending: ReturnType<typeof createDeferredCore<BoundedConversation>> | undefined;
  let consumer: Promise<void> | undefined;
  let consumerError: unknown;
  let skipped: string | undefined;
  let closed = false;
  const taskDone = createDeferredCore();
  const failed = new AbortController();
  const release = async () => {
    closed = true;
    command.resolve({ kind: "close" });
    await taskDone.promise;
  };
  try {
    await runRequest(
      () => ({ kind: "compaction-source", ...input }),
      JSON.stringify(input).length * 2,
      () => undefined,
      signal,
      async (raw, activeSignal) => {
        activeSignal.throwIfAborted();
        // Paired worker and reader own this internal transport contract.
        const reply = raw as SessionCompactionSourceReply;
        if (reply.kind === "skipped") {
          skipped = reply.reason;
          command.resolve({ kind: "close" });
        } else if (reply.kind === "prepared") {
          const source = (name: "history" | "turnPrefix" | "reconciliation", length: number) => ({
            length,
            serialize(maxChars: number): Promise<BoundedConversation> {
              activeSignal.throwIfAborted();
              if (closed) {
                throw new Error("Compaction source is closed");
              }
              if (pending) {
                throw new Error("Compaction source already has a pending serialization");
              }
              pending = createDeferredCore<BoundedConversation>();
              command.resolve({ kind: "serialize", source: name, maxChars });
              return pending.promise;
            },
          });
          const facts = reply.plan.facts;
          consumer = Promise.resolve()
            .then(() =>
              consume(reply.plan, {
                ...facts,
                release,
                signal: signal ? AbortSignal.any([signal, failed.signal]) : failed.signal,
                history: source("history", facts.historyCount),
                turnPrefix: source("turnPrefix", facts.turnPrefixCount),
                reconciliation: source("reconciliation", facts.reconciliationCount),
              }),
            )
            .then(
              () => {
                closed = true;
                command.resolve({ kind: "close" });
              },
              (error: unknown) => {
                consumerError = error;
                closed = true;
                command.resolve({ kind: "close" });
              },
            );
        } else {
          const waiting = pending;
          pending = undefined;
          waiting?.resolve(reply.conversation);
        }
        const abort = addAbortListener(activeSignal, () => {
          failed.abort(activeSignal.reason);
          pending?.reject(activeSignal.reason);
          command.resolve({ kind: "close" });
        });
        try {
          const next = await command.promise;
          command = createDeferredCore<SessionCompactionSourceCommand>();
          return { input: next, timeoutMs };
        } finally {
          abort[Symbol.dispose]();
        }
      },
      timeoutMs,
    );
    taskDone.resolve();
    await consumer;
    if (consumerError !== undefined) {
      throw consumerError instanceof Error
        ? consumerError
        : new Error("Compaction source consumer failed", { cause: consumerError });
    }
    return skipped;
  } catch (error) {
    closed = true;
    failed.abort(error);
    taskDone.resolve();
    command.resolve({ kind: "close" });
    pending?.reject(error);
    await consumer;
    throw error;
  } finally {
    closed = true;
  }
}
