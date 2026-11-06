import { lazy, onSettled } from "solid-js";
import { createIdleImport } from "../../../lib/idle-import.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

const activityLoad = createIdleImport(() => import("./chat-subagent-activity-live.tsx"));
const Activity = lazy(activityLoad.load, { export: "ChatSubagentActivity" });
export const preloadChatSubagentActivity = Activity.preload;

export function ChatSubagentActivity(props: SubagentActivityProps) {
  onSettled(() => activityLoad.dispose);
  return (
    <ChatLazyBoundary>
      <Activity {...props} />
    </ChatLazyBoundary>
  );
}
