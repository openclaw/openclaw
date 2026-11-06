import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatGuardianNotice, ChatItem, ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import type { ChatThreadDisplayProps } from "./chat-thread-display.ts";
import type { ChatInputPlacementProps } from "./chat-thread-inputs.ts";
import type { CompactionStatus } from "./tool-stream-contract.ts";

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
