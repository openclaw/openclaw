import type { GatewaySessionRow } from "../../api/types.ts";

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
