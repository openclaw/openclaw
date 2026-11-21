import { lazy, Show } from "solid-js";
import {
  renderChatComposerNotices as ChatComposerNotices,
  type ChatComposerNoticesProps,
} from "./chat-view-notices.tsx";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";
import type { ParticipantApprovalNotice } from "./session-approval-projection.ts";

const SessionApprovalNotice = lazy(() => import("./session-approval-notice.tsx"), {
  export: "SessionApprovalNotice",
});

export function ChatParticipantNotices(
  props: ChatComposerNoticesProps & { participantApproval?: ParticipantApprovalNotice | null },
) {
  return (
    <>
      <ChatComposerNotices {...props} />
      <Show when={props.participantApproval}>
        {(approval) => (
          <ChatLazyBoundary>
            <SessionApprovalNotice approval={approval()} />
          </ChatLazyBoundary>
        )}
      </Show>
    </>
  );
}
