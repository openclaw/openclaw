import { asOptionalRecord as transcriptEventRecord } from "@openclaw/normalization-core/record-coerce";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-accessor.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../../config/sessions/session-message-rewrite.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { SessionLifecycleRevisionExpectation } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type {
  AssistantDisplayContentBlock,
  AssistantDisplayMediaBySource,
} from "./chat-assistant-content.js";
import {
  buildAssistantDisplayRewrite,
  type ResolvedAssistantTranscriptScope,
} from "./chat-transcript-persistence.js";

/** Enrich the committed occurrence even when input preparation changed the turn watermark. */
export async function rewriteAssistantTranscriptMessageById(params: {
  messageId: string;
  runId: string;
  content: AssistantDisplayContentBlock[];
  mediaBySource?: AssistantDisplayMediaBySource;
  mediaUrls: readonly string[];
  expectedLifecycleRevision: SessionLifecycleRevisionExpectation;
  scope: ResolvedAssistantTranscriptScope;
  assertCurrent: () => void;
  abortSignal?: AbortSignal;
}): Promise<{ generation: string; messageId: string } | null> {
  await waitForSessionTranscriptProjection(params.scope, params.abortSignal);
  params.assertCurrent();
  const anchor = await readActiveTranscriptEntryAnchorAsync({
    ...params.scope,
    entryId: params.messageId,
  });
  params.assertCurrent();
  if (!anchor) {
    return null;
  }
  const rewritten = await rewritePreparedTranscriptMessageAtAnchor(
    anchor,
    (value) => {
      const message = transcriptEventRecord(value);
      if (message?.role !== "assistant" || readSessionTranscriptRunId(message) !== params.runId) {
        return undefined;
      }
      return buildAssistantDisplayRewrite({
        message,
        displayContent: params.content,
        mediaBySource: params.mediaBySource,
        managedMediaUrls: params.mediaUrls,
        retainOriginalText: true,
      });
    },
    {
      active: "sequence",
      expectedEntry: { lifecycleRevision: params.expectedLifecycleRevision },
      assertCurrent: params.assertCurrent,
      assertNativeCurrent: params.assertCurrent,
    },
  );
  return rewritten ? { generation: rewritten.generation, messageId: params.messageId } : null;
}
