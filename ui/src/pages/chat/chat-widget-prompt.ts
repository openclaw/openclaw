import { claimChatSubmissionAction } from "./chat-submission-action.ts";
import type { WidgetPromptEventDetail } from "./components/chat-tool-cards.ts";

type ChatWidgetPromptHost = {
  handleSendChat: (message: string, options: { submissionId: string }) => Promise<void>;
};

export function submitChatWidgetPrompt(
  host: ChatWidgetPromptHost | null | undefined,
  event: Event,
): void {
  const detail = (event as CustomEvent<Partial<WidgetPromptEventDetail>>).detail;
  const text = typeof detail?.text === "string" ? detail.text.trim() : "";
  if (!host || !text) {
    return;
  }
  const claim = claimChatSubmissionAction(event);
  if (claim.firstUse) {
    void host.handleSendChat(text, { submissionId: claim.submissionId });
  }
}
