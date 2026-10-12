import { randomUUID } from "node:crypto";
import { logVerbose } from "../../globals.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { runAfterReplyOperationClear, type ReplyOperation } from "./reply-run-registry.js";
import type { TypingController } from "./typing.js";

const typingByReplyOperation = new WeakMap<ReplyOperation, TypingController>();

/** Keep one feedback controller attached to the task that owns a reply run. */
export function bindReplyOperationTyping(
  operation: ReplyOperation,
  typing: TypingController,
): void {
  if (typingByReplyOperation.has(operation)) {
    return;
  }
  typingByReplyOperation.set(operation, typing);
  runAfterReplyOperationClear(operation, () => {
    typingByReplyOperation.delete(operation);
    typing.cleanup();
  });
}

/** Refresh the continuing task's feedback after it adopts another inbound turn. */
export async function refreshReplyOperationTyping(
  operation: ReplyOperation,
  options: { startIfIdle: boolean },
): Promise<void> {
  const typing = typingByReplyOperation.get(operation);
  if (!typing || operation.result || (!options.startIfIdle && !typing.isActive())) {
    return;
  }
  await typing.startTypingLoop();
}

const inputRunIds = new WeakMap<ReplyOperation, string>();
const includedSources = new WeakMap<ReplyOperation, WeakSet<TurnAdoptionLifecycle>>();

/** Publish feedback for confirmed input without giving a channel run mutation authority. */
export function notifyReplyRunInputIncluded(
  operation: ReplyOperation,
  lifecycle: TurnAdoptionLifecycle | undefined,
): void {
  if (!lifecycle?.onRunIncluded || operation.result || !operation.ownerSettlement) {
    return;
  }
  const sources = includedSources.get(operation) ?? new WeakSet<TurnAdoptionLifecycle>();
  if (sources.has(lifecycle)) {
    return;
  }
  sources.add(lifecycle);
  includedSources.set(operation, sources);
  let runId = inputRunIds.get(operation);
  if (!runId) {
    runId = randomUUID();
    inputRunIds.set(operation, runId);
  }
  try {
    lifecycle.onRunIncluded({ runId, completion: operation.ownerSettlement });
  } catch (error) {
    logVerbose(`channel input feedback failed: ${String(error)}`);
  }
}
