import { createMemo } from "solid-js";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { createTranscriptMemo, transcriptArraysEqual } from "./chat-transcript-memo.ts";

const persistedMessageIds = createTranscriptMemo<Set<string | null>>();

export function projectRealtimeTalkConversation(
  props: Pick<
    ChatThreadProps,
    "assistantName" | "userName" | "messages" | "readRealtimeTalkConversation" | "transcriptVisible"
  >,
) {
  const presentation = createMemo(() => projectPresentation(props.transcriptVisible ?? true));
  // Voice captions reconcile against unfiltered immutable history, not the
  // current search or streaming projection.
  const entries = createParkedProjection(
    () =>
      (props.readRealtimeTalkConversation?.() ?? []).filter((entry) => {
        if (!entry.transcriptId) {
          return true;
        }
        return !persistedMessageIds(
          props.messages,
          [],
          () => new Set(props.messages.map(persistedMessageEntryId)),
        ).has(entry.transcriptId);
      }),
    () => presentation().read(),
  );
  // Blocks change only when a caption opens or retires a history position, so
  // caption text updates re-render the caption blocks, not the transcript.
  const anchors = createMemo(() => [...new Set(entries().map((entry) => entry.afterMessageId))], {
    equals: transcriptArraysEqual,
  });
  return {
    hasEntries: createMemo(() => entries().length > 0),
    blocks: createMemo(() =>
      anchors().map((afterMessageId) => ({
        afterMessageId,
        content: {
          kind: "realtime" as const,
          assistantName: props.assistantName,
          userName: props.userName,
          get entries() {
            return entries().filter((entry) => entry.afterMessageId === afterMessageId);
          },
        },
      })),
    ),
  };
}
