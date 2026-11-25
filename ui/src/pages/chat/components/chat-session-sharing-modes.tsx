import type { SessionVisibility } from "../../../api/types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatSessionSharingModeIcon } from "./chat-session-sharing-shared.tsx";

export const CHAT_SESSION_SHARING_DESCRIPTION_KEYS: Record<SessionVisibility, string> = {
  shared: "chat.sessionSharing.sharedDescription",
  "read-only": "chat.sessionSharing.readOnlyDescription",
  suggest: "chat.sessionSharing.suggestDescription",
  draft: "chat.sessionSharing.draftDescription",
};

export function createChatSessionSharingModes() {
  const mode = (value: SessionVisibility) => ({
    get description() {
      return t(CHAT_SESSION_SHARING_DESCRIPTION_KEYS[value]);
    },
    icon: () => <ChatSessionSharingModeIcon visibility={value} />,
  });
  return {
    shared: mode("shared"),
    "read-only": mode("read-only"),
    suggest: mode("suggest"),
    draft: mode("draft"),
  };
}
