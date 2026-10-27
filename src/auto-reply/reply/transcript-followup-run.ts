import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import type { FollowupRun } from "./queue/types.js";

/** Internal continuations reuse the transcript, not the source turn's admission. */
export function buildTranscriptFollowupRun(
  base: FollowupRun,
  params: { prompt: string; sourceTool: string; expiredSkillAuthoringMessage: string },
): FollowupRun {
  const source = base.queuedFollowupReplyDisposition;
  return {
    ...base,
    prompt: formatSystemTurnPrompt(params.prompt),
    disableCollectBatching: true,
    enqueuedAt: Date.now(),
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    sourceTurnId: undefined,
    currentInboundContext: undefined,
    images: undefined,
    imageOrder: undefined,
    media: undefined,
    controllerInput: undefined,
    controllerClaim: undefined,
    turnAdoptionLifecycle: undefined,
    replyOperationRunStates: undefined,
    onQueueDisposition: undefined,
    queuedFollowupReplyDisposition:
      source?.kind === "deliver"
        ? { kind: "deliver", deliver: source.deliver.createSourceRetry?.() ?? source.deliver }
        : source,
    run: {
      ...base.run,
      inputProvenance: { kind: "internal_system", sourceTool: params.sourceTool },
      suppressNextUserMessagePersistence: true,
      skillLibraryAuthoring: expireSkillLibraryAuthoring(
        base.run.skillLibraryAuthoring,
        params.expiredSkillAuthoringMessage,
      ),
    },
  };
}

/**
 * The source grant cannot authorize a replacement turn. Keep a personal-only
 * expired grant so Workshop cannot fall back to wider workspace authoring.
 */
export function expireSkillLibraryAuthoring(
  grant: FollowupRun["run"]["skillLibraryAuthoring"],
  message: string,
): FollowupRun["run"]["skillLibraryAuthoring"] {
  return (
    grant && {
      target: "personal",
      defaultTarget: "personal",
      multipleProfiles: grant.multipleProfiles,
      bind: () => {},
      invoke: async () => {
        throw new SkillLibraryError("AUTHORITY_EXPIRED", message);
      },
    }
  );
}
