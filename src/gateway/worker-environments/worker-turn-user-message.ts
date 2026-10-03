import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { SessionTranscriptMessageCommittedError } from "../../agents/sessions/session-manager-message-error.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import type { prepareWorkerTurnMedia } from "./worker-turn-media.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";

export async function persistWorkerTurnUserMessage(params: {
  turn: Pick<
    SessionPlacementTurnParams,
    "prompt" | "transcriptPrompt" | "media" | "onUserMessagePersisted"
  >;
  manager: SessionManager;
  transcriptTarget: BoundAgentRunSessionTarget;
  media: Pick<Awaited<ReturnType<typeof prepareWorkerTurnMedia>>, "images" | "imageFactIndexes">;
  assertRunCurrent?: () => void;
  isAuthorized: () => boolean;
}): Promise<string | null> {
  const { turn, manager, transcriptTarget, media } = params;
  const canonical = buildPersistedUserTurnMessage({
    text: turn.transcriptPrompt ?? turn.prompt,
    media: turn.media,
    mediaImageLayout: {
      slots: media.imageFactIndexes.map((factIndex) => ({
        kind: "inline" as const,
        ...(factIndex === null ? {} : { factIndex }),
      })),
    },
  });
  const message = {
    ...canonical,
    content: [
      { type: "text" as const, text: turn.transcriptPrompt ?? turn.prompt },
      ...media.images,
    ],
    __openclaw: {
      ...canonical["__openclaw"],
      mediaImageBlockFactIndexes: media.imageFactIndexes,
    },
  };
  const assertCurrent = () => {
    params.assertRunCurrent?.();
    if (!params.isAuthorized()) {
      throw new Error("Worker turn authority changed before transcript write");
    }
    resolveWorkerTurnTranscriptTarget({ ...transcriptTarget, sessionTarget: transcriptTarget });
  };
  const entryId = await withSessionTranscriptWriteAssertion(transcriptTarget, assertCurrent, () =>
    withSessionManagerWrite(manager, () => manager.appendMessageAsync(message)),
  );
  try {
    assertCurrent();
    turn.onUserMessagePersisted?.(message);
  } catch (error) {
    if (entryId) {
      throw new SessionTranscriptMessageCommittedError(entryId, error, transcriptTarget);
    }
    throw error;
  }
  return entryId ?? null;
}
