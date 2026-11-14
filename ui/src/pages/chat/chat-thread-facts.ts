import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import type { ReplyAttributionFacts } from "./chat-thread-grouping.ts";
import {
  isKeyedAssistantStreamFallbackMessage,
  transcriptRunId,
} from "./chat-thread-run-identity.ts";

/**
 * Transcript-wide facts of one build. An older-page prepend reuses retained rows
 * only while the new page cannot change them (see chat-thread-prepend.ts).
 */
export type ChatItemsFacts = ReplyAttributionFacts & {
  /** Display history after heartbeat/commentary filtering and composition. */
  history?: readonly unknown[];
  /** First history message owning each persisted canvas identity or inline view key. */
  firsts: Map<string, unknown>;
  /** History messages whose divider key includes their transcript index. */
  indexedDividers: unknown[];
  /** Model-selection state entering this message. */
  probe?: unknown;
  modelBefore?: string;
};

/** Messages the transcript displays, in display order. */
export function displayChatHistory(
  props: { messages: unknown[]; persistCommentary?: boolean },
  activeCommentaryRunId?: string,
): unknown[] {
  return composeTranscriptDisplay(
    props.messages.filter(
      (message) =>
        !isAssistantHeartbeatAckForDisplay(message) &&
        (props.persistCommentary !== false ||
          !isKeyedAssistantStreamFallbackMessage(message) ||
          (activeCommentaryRunId !== undefined &&
            transcriptRunId(message) === activeCommentaryRunId)),
    ),
  );
}
