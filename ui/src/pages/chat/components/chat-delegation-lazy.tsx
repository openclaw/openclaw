import { lazy } from "solid-js";
import type { ChatDelegationProps } from "./chat-delegation.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const Delegation = lazy(() => import("./chat-delegation.tsx"), { export: "ChatDelegation" });

/** Optional task detail must never suspend the transcript or the composer. */
export function ChatDelegationRow(props: ChatDelegationProps) {
  return (
    <ChatLazyBoundary>
      <Delegation {...props} />
    </ChatLazyBoundary>
  );
}
