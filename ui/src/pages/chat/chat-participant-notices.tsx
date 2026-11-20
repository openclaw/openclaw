import {
  renderChatComposerNotices as ChatComposerNotices,
  type ChatComposerNoticesProps,
} from "./chat-view-notices.tsx";
import { SessionApprovalNotice } from "./session-approval-notice.tsx";
import type { ParticipantApprovalNotice } from "./session-approval-projection.ts";

export function ChatParticipantNotices(
  props: ChatComposerNoticesProps & { participantApproval?: ParticipantApprovalNotice | null },
) {
  return (
    <>
      <ChatComposerNotices {...props} />
      <SessionApprovalNotice approval={props.participantApproval ?? null} />
    </>
  );
}
