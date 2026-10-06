import type { AcceptedSessionSpawn } from "../../agents/accepted-session-spawn.js";
import type { ReplyCompletion } from "../../agents/reply-completion.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export function buildWaitingStatusPayload(params: {
  completion: ReplyCompletion;
  continuationPending?: boolean;
  yieldAcknowledgment?: string;
  yielded?: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  if (
    params.completion.expectation !== "required" ||
    params.completion.outcome !== "pending" ||
    (!params.yielded && !params.continuationPending) ||
    params.hasVisibleMessageDelivery
  ) {
    return undefined;
  }
  return setReplyPayloadMetadata(
    {
      text:
        params.yieldAcknowledgment?.trim() ||
        "I’m continuing this work and will send the result when it is ready.",
    },
    {
      deliverDespiteSourceReplySuppression: true,
      continuationStatus: true,
    },
  );
}

/** Ordinary and queued waiting replies offer their progress draft to the yielding turn's children. */
export async function attachWaitingStatusProgressContinuation(params: {
  payload: ReplyPayload;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  operation: ReplyOperation;
}): Promise<void> {
  const { acceptedSessionSpawns, operation } = params;
  if (!acceptedSessionSpawns?.length) {
    return;
  }
  // Ordinary replies must not load the subagent registry.
  const { adoptSubagentProgressDraft } =
    await import("../../agents/subagents/registry/subagent-progress-draft.js");
  let open = true;
  setReplyPayloadMetadata(params.payload, {
    progressContinuation: {
      adopt: (draft) =>
        open &&
        resolveReplyOperationAbortReason(operation) === undefined &&
        adoptSubagentProgressDraft(acceptedSessionSpawns, draft),
      close: () => {
        open = false;
      },
    },
  });
}
