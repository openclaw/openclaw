import { lazy } from "solid-js";
import "../../../styles/chat/skill-learned-notice.css";
import "../../../styles/session-menu.css";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";

export const nativeRows = {
  "system-events": lazy(() => import("./chat-system-events.tsx"), { export: "ChatSystemEvents" }),
  group: MessageGroup,
  activity: ActivityGroup,
  stream: lazy(() => import("./chat-message-stream-view.tsx"), { export: "StreamGroup" }),
  work: lazy(() => import("./chat-work-group-summary.tsx"), { export: "WorkGroupSummary" }),
  frame: lazy(() => import("./chat-agent-run-frame.tsx"), { export: "AgentRunFrame" }),
  wait: lazy(() => import("./chat-message-stream-view.tsx"), { export: "UnplacedSubagentWait" }),
  divider: lazy(() => import("./chat-divider.tsx"), { export: "ChatDivider" }),
  notice: lazy(() => import("./chat-divider.tsx"), { export: "ChatNotice" }),
  "work-previews": lazy(() => import("./chat-transcript-content.tsx"), {
    export: "TranscriptWorkPreviews",
  }),
  realtime: lazy(() => import("./chat-realtime-controls.tsx"), {
    export: "RealtimeTalkConversation",
  }),
  recap: lazy(() => import("./chat-turn-recap-view.tsx"), { export: "TurnRecapRow" }),
  typing: lazy(() => import("./chat-typing-indicator.tsx"), { export: "ChatTypingIndicator" }),
};

export type NativeTranscriptView = {
  [Kind in keyof typeof nativeRows]: { kind: Kind } & Parameters<(typeof nativeRows)[Kind]>[0];
}[keyof typeof nativeRows];
