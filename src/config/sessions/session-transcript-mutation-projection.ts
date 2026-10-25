import type { SessionRowTranscriptProjection } from "../../gateway/session-row-transcript-preview.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import type { TranscriptWindowUpdate } from "./session-transcript-index-postgres.js";

/** A turn persists several strict logical advances and one folded publication. */
export type TranscriptMutationAdvance = {
  steps: number;
  adjustedTime: number;
  publicationAssistant?: SessionTranscriptAuthority["lastAssistantMessage"];
};

export type TranscriptMutationOptions = {
  strictly?: boolean;
  steps?: number;
  windowUpdatedAt?: number;
  rowTranscript?: SessionRowTranscriptProjection;
  publicationAssistant?: SessionTranscriptAuthority["lastAssistantMessage"];
  persistActorMutation?: boolean;
  writeActorMutation?: (update: TranscriptWindowUpdate) => void;
};

export function projectTranscriptMutationPublication(
  rowTranscript: SessionRowTranscriptProjection | undefined,
  publicationAssistant: SessionTranscriptAuthority["lastAssistantMessage"],
): Pick<
  SessionTranscriptAuthority,
  "lastMessagePreview" | "lastAssistantMessage" | "terminalModel"
> {
  return {
    ...(rowTranscript
      ? {
          lastMessagePreview: rowTranscript.lastMessagePreview,
          lastAssistantMessage: rowTranscript.lastAssistantMessage,
          terminalModel: rowTranscript.terminalModel,
        }
      : {}),
    ...(publicationAssistant !== undefined ? { lastAssistantMessage: publicationAssistant } : {}),
  };
}
