import { lazy } from "solid-js";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const WorkingIndicator = lazy(() => import("./chat-working-indicator.tsx"), {
  export: "ChatWorkingIndicator",
});
// Settled text history needs neither active-run controls nor their timer owners.
export function ChatWorkingIndicator(
  props: Parameters<typeof import("./chat-working-indicator.tsx").ChatWorkingIndicator>[0],
) {
  return (
    <ChatLazyBoundary>
      <WorkingIndicator {...props} />
    </ChatLazyBoundary>
  );
}
