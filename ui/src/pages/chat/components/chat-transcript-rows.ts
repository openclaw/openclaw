import { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import { ChatDelegationRow } from "./chat-delegation-lazy.tsx";
import { ChatDivider, ChatNotice } from "./chat-divider.tsx";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import {
  StreamGroup,
  UnplacedSubagentWait,
  WorkGroupSummary,
} from "./chat-message-stream-view.tsx";
import { RealtimeTalkConversation } from "./chat-realtime-controls.tsx";
import { ChatSystemEvents } from "./chat-system-events.tsx";
import { TranscriptWorkPreviews } from "./chat-transcript-content.tsx";
import { ChatTypingIndicator } from "./chat-typing-indicator.tsx";
import { TurnRecapRow } from "./chat-working-indicator.tsx";

export const nativeRows = {
  delegation: ChatDelegationRow,
  "system-events": ChatSystemEvents,
  group: MessageGroup,
  activity: ActivityGroup,
  stream: StreamGroup,
  work: WorkGroupSummary,
  frame: AgentRunFrame,
  wait: UnplacedSubagentWait,
  divider: ChatDivider,
  notice: ChatNotice,
  "work-previews": TranscriptWorkPreviews,
  realtime: RealtimeTalkConversation,
  recap: TurnRecapRow,
  typing: ChatTypingIndicator,
};

export type NativeTranscriptView = {
  [Kind in keyof typeof nativeRows]: { kind: Kind } & Parameters<(typeof nativeRows)[Kind]>[0];
}[keyof typeof nativeRows];
