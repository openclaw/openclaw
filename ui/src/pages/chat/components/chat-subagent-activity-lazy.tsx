import type { JSX } from "@solidjs/web";
import { lazy } from "solid-js";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

const Activity = lazy(() => import("./chat-subagent-activity-live.tsx"), {
  export: "ChatSubagentActivity",
});

export function ChatSubagentActivity(props: SubagentActivityProps & { fallback?: JSX.Element }) {
  return (
    <ChatLazyBoundary fallback={props.fallback}>
      <Activity {...props} />
    </ChatLazyBoundary>
  );
}
