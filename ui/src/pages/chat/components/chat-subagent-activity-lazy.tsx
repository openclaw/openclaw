import { lazy } from "solid-js";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

const Activity = lazy(() => import("./chat-subagent-activity-live.tsx"), {
  export: "ChatSubagentActivity",
});

export function ChatSubagentActivity(props: SubagentActivityProps) {
  return (
    <ChatLazyBoundary>
      <Activity {...props} />
    </ChatLazyBoundary>
  );
}
