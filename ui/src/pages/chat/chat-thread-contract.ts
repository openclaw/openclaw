import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatGuardianNotice, ChatItem, ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import type { ChatInputPlacementProps } from "./chat-thread-inputs.ts";
import type { ChatReasoning, CompactionStatus } from "./tool-stream-contract.ts";

export type ChatThreadDisplayProps = {
  runId?: string | null;
  reasoning?: ChatReasoning | null;
  showReasoning?: boolean;
  stream: string | null;
  streamStartedAt: number | null;
  showToolCalls: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** People the session row lists, loaded or not, keyed by `sessionParticipantIdentityKey`. */
  replyPeople?: readonly string[];
  /** Key of the signed-in viewer, who authors local user messages without a sender. */
  replyLocalPerson?: string;
};

export type BuildChatItemsProps = ChatInputPlacementProps &
  ChatThreadDisplayProps & {
    paneId: string;
    sessionKey: string;
    archiveNotice?: Extract<ChatItem, { kind: "notice" }>;
    compactionStatus?: CompactionStatus | null;
    /** Invalidates cached display copy when the active UI language changes. */
    locale?: string;
    messages: unknown[];
    toolMessages: unknown[];
    guardianNotices?: ChatGuardianNotice[];
    streamSegments: ChatStreamSegment[];
    persistCommentary?: boolean;
    /** The answer is visible or the runtime only owns background settlement. */
    runFinalizing?: boolean;
    /** True while the current session has an abortable live run. */
    runActive?: boolean;
    /** Set while a run that handed off is idle and its subagents are still running. */
    subagentWait?: { startedAt: number; runId: string };
    questionPrompts?: readonly QuestionPrompt[];
    /** True while chat history is loading (initial load or background reload). */
    loading?: boolean;
  };
