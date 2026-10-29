import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatGuardianNotice, ChatItem, ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import type { ChatInputPlacementProps } from "./chat-thread-inputs.ts";
import type { ChatReasoning, CompactionStatus } from "./tool-stream-contract.ts";

/** One thread build's inputs; the item cache compares them structurally before rebuilding. */
export type BuildChatItemsProps = ChatInputPlacementProps & {
  paneId: string;
  sessionKey: string;
  archiveNotice?: Extract<ChatItem, { kind: "notice" }>;
  runId?: string | null;
  compactionStatus?: CompactionStatus | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  guardianNotices?: ChatGuardianNotice[];
  streamSegments: ChatStreamSegment[];
  reasoning?: ChatReasoning | null;
  showReasoning?: boolean;
  stream: string | null;
  streamStartedAt: number | null;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** The answer is visible or the runtime only owns background settlement. */
  runFinalizing?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  /** Set while a run that handed off is idle and its subagents are still running. */
  subagentWait?: { startedAt: number; runId: string };
  questionPrompts?: readonly QuestionPrompt[];
  /** Failed run continued by Try again; its notice is superseded. */
  retriedRunId?: string;
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
  /** People the session row lists, loaded or not, keyed by `sessionParticipantIdentityKey`. */
  replyPeople?: readonly string[];
  /** Key of the signed-in viewer, who authors local user messages without a sender. */
  replyLocalPerson?: string;
};
