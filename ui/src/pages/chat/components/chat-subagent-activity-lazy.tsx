import { Show, createSignal, lazy, onSettled } from "solid-js";
import { createIdleImport } from "../../../lib/idle-import.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

export function ChatSubagentActivity(props: SubagentActivityProps) {
  const activityLoad = createIdleImport(() => import("./chat-subagent-activity-live.tsx"));
  const Activity = lazy(activityLoad.load, { export: "ChatSubagentActivity" });
  // A cached body joins the existing Details boundary once; live adoption keeps its DOM.
  const [cachedAdmission] = createSignal<boolean>(
    (previous) => previous ?? Boolean(props.presentation),
  );
  onSettled(() => activityLoad.dispose);
  return (
    <Show
      when={cachedAdmission()}
      fallback={
        <ChatLazyBoundary>
          <Activity {...props} />
        </ChatLazyBoundary>
      }
    >
      <Activity {...props} />
    </Show>
  );
}
