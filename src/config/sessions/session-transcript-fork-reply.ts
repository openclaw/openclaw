import { isDeepStrictEqual } from "node:util";
import type { ConversationRef } from "../../infra/outbound/session-binding.types.js";
import { withRecentSessionTranscriptActiveEventsInSnapshot } from "./session-accessor.sqlite-active-events-read.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.types.js";

export type SessionForkReplySelection =
  | { status: "found"; entryId: string; text: string }
  | { status: "media" }
  | { status: "missing" };

/** Select one active-path reply target inside the transcript worker's read snapshot. */
export function readSessionForkReplySelection(input: {
  target: SessionTranscriptReadScope;
  replyToId: string;
  conversation: ConversationRef;
  replyConversationRef?: string;
}): SessionForkReplySelection {
  return withCurrentProjectionSnapshot(input.target, (projection) =>
    withRecentSessionTranscriptActiveEventsInSnapshot(projection, 2_000, (visit) => {
      let matched = false;
      let result: SessionForkReplySelection = { status: "missing" };
      visit((candidate) => {
        if (matched) {
          return;
        }
        // SAFETY: transcript events are partial untrusted records; every consumed field is checked.
        const event = candidate as {
          id?: unknown;
          message?: {
            role?: unknown;
            content?: unknown;
            media?: unknown;
            __openclaw?: {
              transport?: {
                messageId?: unknown;
                conversation?: unknown;
                conversationRef?: unknown;
                channel?: unknown;
              };
              media?: unknown;
            };
          };
        };
        const message = event.message;
        const transport = message?.["__openclaw"]?.transport;
        if (
          typeof event.id !== "string" ||
          message?.role !== "user" ||
          transport?.messageId !== input.replyToId ||
          (input.replyConversationRef
            ? transport?.conversationRef !== input.replyConversationRef ||
              transport?.channel !== input.conversation.channel
            : !isDeepStrictEqual(transport?.conversation, input.conversation))
        ) {
          return;
        }
        matched = true;
        const media = message["__openclaw"]?.media ?? message.media;
        if (Array.isArray(media) && media.length > 0) {
          result = { status: "media" };
          return;
        }
        const content = message.content;
        if (
          Array.isArray(content) &&
          content.some(
            (part) =>
              !part ||
              typeof part !== "object" ||
              !("type" in part) ||
              part.type !== "text" ||
              !("text" in part) ||
              typeof part.text !== "string",
          )
        ) {
          result = { status: "media" };
          return;
        }
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((part) => {
                    // SAFETY: the preceding array guard verified every part is a text record.
                    return part.text as string;
                  })
                  .join("")
              : "";
        result = text.trim() ? { status: "found", entryId: event.id, text } : { status: "missing" };
      });
      return result;
    }),
  );
}
