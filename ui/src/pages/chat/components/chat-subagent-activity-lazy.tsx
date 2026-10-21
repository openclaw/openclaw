import type { JSX } from "@solidjs/web";
import { lazy, Loading } from "solid-js";
import type { SubagentActivityProps } from "./chat-subagent-activity.ts";

const Activity = lazy(() => import("./chat-subagent-activity-live.tsx"), {
  export: "ChatSubagentActivity",
});

export function ChatSubagentActivity(props: SubagentActivityProps & { fallback?: JSX.Element }) {
  return (
    <Loading fallback={props.fallback}>
      <Activity {...props} />
    </Loading>
  );
}
