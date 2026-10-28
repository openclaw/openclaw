import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { findTranscriptEvent } from "../../config/sessions/session-transcript-match.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import type { AssistantDisplayContentBlock } from "./chat-assistant-content.js";
import type { ResolvedAssistantTranscriptScope } from "./chat-transcript-persistence.js";

/** Read display content already owned by a committed source-reply mirror on the active branch. */
export async function readCommittedSourceReplyContent(params: {
  scope: ResolvedAssistantTranscriptScope;
  payload: ReplyPayload;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<AssistantDisplayContentBlock[] | undefined> {
  const mirror = getReplyPayloadMetadata(params.payload)?.sourceReplyTranscriptMirror;
  if (!mirror?.transcriptOwner || !mirror.idempotencyKey) {
    return undefined;
  }
  const found = await findTranscriptEvent(params.scope, {
    kind: "idempotency",
    key: mirror.idempotencyKey,
    deliveryMirror: true,
  });
  params.assertCurrent();
  const messageId = found && readTranscriptEventId(found.event);
  if (!messageId) {
    return undefined;
  }
  const { anchors } = await readSessionTranscriptAnchorsAsync(
    params.scope,
    { entryIds: [messageId] },
    params.abortSignal,
  );
  params.assertCurrent();
  const content = readAssistantDisplayContent(readTranscriptEventMessage(found.event));
  return anchors.length > 0 && content.length > 0 ? content : undefined;
}
