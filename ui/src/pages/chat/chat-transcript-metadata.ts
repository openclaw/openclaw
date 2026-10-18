import type {
  ChatHistoryDeltaResult,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";

export type ChatHistoryState = {
  stateRevision: NonNullable<ChatHistoryDeltaResult["stateRevision"]>;
  pendingInputs?: ChatPendingInputsPage;
  sessionInfo?: GatewaySessionRow;
  commands?: ChatMetadataResult["commands"];
};

export const CHAT_TRANSCRIPT_METADATA_KEYS = [
  "key",
  "kind",
  "label",
  "displayName",
  "derivedTitle",
  "classification",
  "participants",
  "expandedParticipants",
  "owner",
  "lastRunId",
  "status",
  "runtimeMs",
] as const;
export type ChatTranscriptMetadata = Pick<
  GatewaySessionRow,
  (typeof CHAT_TRANSCRIPT_METADATA_KEYS)[number]
>;
