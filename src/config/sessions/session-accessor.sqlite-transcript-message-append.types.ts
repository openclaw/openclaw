import type { PreparedTranscriptPayload } from "./transcript-payload.js";

export type PreparedTranscriptMessageAppend<TMessage> = {
  messageJson: string;
  persistedMessage: TMessage;
  physicalPayload?: PreparedTranscriptPayload;
};
