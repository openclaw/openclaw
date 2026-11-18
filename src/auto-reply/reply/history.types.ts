import type { MediaFact } from "../../media/media-facts.js";

export type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  media?: HistoryMediaEntry[];
};

export type HistoryMediaEntry = Pick<
  MediaFact,
  "contentType" | "durationMs" | "height" | "kind" | "messageId" | "path" | "url" | "width"
>;
