export const CHAT_TRANSCRIPT_READY_EVENT = "openclaw-chat-transcript-ready";

export type ChatTranscriptReadyDetail = {
  paneId: string;
  sessionKey: string;
};

declare global {
  interface HTMLElementEventMap {
    [CHAT_TRANSCRIPT_READY_EVENT]: CustomEvent<ChatTranscriptReadyDetail>;
  }
}
