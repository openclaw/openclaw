import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ASYNC_QUESTION_ANSWERED,
  assertAsyncQuestionSource,
  readAsyncQuestionAnswer,
} from "../../shared/async-question-answer.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export function assertMemoryAsyncQuestionAdmission(
  state: SessionActorMemoryWindow,
  message: unknown,
): void {
  const answer = readAsyncQuestionAnswer(message);
  if (!answer) {
    return;
  }
  const tree = scanSessionTranscriptTree(state.events.map(({ event }) => event));
  const active = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const source = active.find((node) => node.id === answer.sourceMessageId);
  assertAsyncQuestionSource(asOptionalRecord(source?.entry)?.message, answer.itemId);
  const matches = (value: unknown) => {
    const candidate = asOptionalRecord(value);
    return (
      candidate?.role === "user" &&
      candidate.idempotencyKey !== answer.idempotencyKey &&
      asOptionalRecord(candidate["__openclaw"])?.replyToId === answer.sourceMessageId
    );
  };
  if (
    [...state.pendingInputs.values()].some(
      (row) =>
        row.state !== "cancelled" &&
        row.consumed_event_id === null &&
        matches(JSON.parse(row.message_json)),
    ) ||
    active.some((node) => matches(asOptionalRecord(node.entry)?.message))
  ) {
    throw new Error(ASYNC_QUESTION_ANSWERED);
  }
}
