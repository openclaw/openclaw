import { lazy, onSettled } from "solid-js";
import { createIdleImport } from "../../../lib/idle-import.ts";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

export function ChatSubagentActivity(props: SubagentActivityProps) {
  const activityLoad = createIdleImport(() => import("./chat-subagent-activity-live.tsx"));
  const Activity = lazy(activityLoad.load, { export: "ChatSubagentActivity" });
  // The existing Details boundary admits the complete body only when its section opens.
  onSettled(() => activityLoad.dispose);
  return <Activity {...props} />;
}
