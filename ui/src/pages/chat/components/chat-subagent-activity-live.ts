import { createComponent, lazy, Loading } from "solid-js";
import type { SubagentActivityProps } from "./chat-subagent-activity.ts";

const Activity = lazy(() => import("./chat-subagent-activity-live.tsx"), {
  export: "ChatSubagentActivity",
});

export function ChatSubagentActivity(props: SubagentActivityProps) {
  return createComponent(Loading, {
    get children() {
      return createComponent(Activity, props);
    },
  });
}
