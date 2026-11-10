import { lazy, onSettled } from "solid-js";
import { createIdleImport } from "../../../lib/idle-import.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { SubagentActivity, type SubagentActivityProps } from "./chat-subagent-activity.tsx";

const activityLoad = createIdleImport(() => import("./chat-subagent-activity-live.tsx"));
const Activity = lazy(activityLoad.load, { export: "ChatSubagentActivity" });

export function ChatSubagentActivity(
  props: Omit<SubagentActivityProps, "rows"> & {
    rows: readonly import("../chat-subagent-wait.ts").ChatSubagentActivity[];
  },
) {
  onSettled(() => activityLoad.dispose);
  return (
    <ChatLazyBoundary
      fallback={<SubagentActivity {...props} presentation={props.presentation ?? props.rows} />}
    >
      <Activity {...props} />
    </ChatLazyBoundary>
  );
}
