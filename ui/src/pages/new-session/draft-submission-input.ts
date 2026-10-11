import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import { attachmentBatchRejection } from "../chat/components/chat-attachment-admission.ts";
import { prepareBackgroundSessionCompletion } from "./background-session-notice.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftStartupResumption } from "./draft-session-startup.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

/** Freeze the selected or recovered input before creation can yield to another draft. */
export function prepareDraftSubmission(
  context: ApplicationContext,
  draft: {
    message: string;
    mentions: readonly HumanMention[];
    attachmentDraft: { attachments: ChatAttachment[] };
    pendingPlacement: PendingSessionPlacementRecoveryState;
    visibility: NewSessionVisibility;
  },
  place: DraftPlaceState,
  startup?: DraftStartupResumption,
  background = false,
) {
  const pending = draft.pendingPlacement;
  const pendingPlacement = !startup && Boolean(pending.sessionKey);
  const submitted = trimHumanMentions(draft.message, draft.mentions);
  const message = startup?.params.message ?? (pendingPlacement ? pending.message : submitted.text);
  const mentions = (
    startup ? startup.params.mentions : pendingPlacement ? pending.mentions : submitted.mentions
  )?.map(({ profileId, start, end }) => ({ profileId, start, end }));
  const attachments = draft.attachmentDraft.attachments;
  if (!startup && !pendingPlacement) {
    const error = attachmentBatchRejection(attachments, context.gateway.snapshot.hello?.policy);
    if (error !== undefined) {
      showToast({ message: error });
      return null;
    }
  }
  const draftAttachments = startup
    ? startup.params.attachments
    : pendingPlacement
      ? undefined
      : buildChatApiAttachments(attachments);
  const apiAttachments = pendingPlacement ? pending.attachments : draftAttachments;
  const submissionAgentId =
    startup?.params.agentId ??
    (pendingPlacement ? pending.agentId : normalizeAgentId(place.agentId));
  const gatewayUrl = pendingPlacement ? pending.gatewayUrl : context.gateway.connection.gatewayUrl;
  const client = context.gateway.snapshot.client;
  if (!client || !context.gateway.snapshot.hello) {
    return null;
  }
  const completeInBackground = prepareBackgroundSessionCompletion({
    enabled: background,
    agentId: submissionAgentId,
    client,
    context,
  });
  const recoveryScope = pendingPlacement ? pending.recoveryScope : client.recoveryScope;
  const submittedPlacement =
    startup?.params ??
    (pendingPlacement
      ? pending.createParams
      : buildSelectedSessionCreateParams(place, { message, visibility: draft.visibility }));
  return {
    consumeWorktreeName:
      submittedPlacement &&
      place.captureSubmittedWorktreeName(
        submittedPlacement,
        submissionAgentId,
        Boolean(startup || pendingPlacement),
      ),
    pendingPlacement,
    message,
    mentions,
    attachments,
    draftAttachments,
    apiAttachments,
    agentId: submissionAgentId,
    gatewayUrl,
    client,
    recoveryScope,
    completeInBackground,
    hasInitialTurn: Boolean(message || apiAttachments?.length),
  };
}
