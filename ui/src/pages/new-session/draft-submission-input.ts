import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import { prepareBackgroundSessionCompletion } from "./background-session-notice.ts";
import type { NewSessionCapabilityController } from "./capability-controller.ts";
import type { DraftSessionCreateOverrides, NewSessionVisibility } from "./create-params.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftStartupResumption } from "./draft-session-startup.ts";
import type { DraftSubmissionSnapshot } from "./draft-submission-contract.ts";
import type { NewSessionPermissionSelection } from "./permission-selection.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

/** Project the draft's explicit choices through the existing session-create parameter owner. */
export function buildDraftSubmissionCreateParams(
  place: DraftPlaceState,
  gateway: DraftGatewayState,
  draft: {
    capabilities: Pick<NewSessionCapabilityController, "toolOverrides">;
    permission: Pick<NewSessionPermissionSelection, "value">;
    visibility: NewSessionVisibility;
  },
  snapshot: DraftSubmissionSnapshot,
  options: DraftSessionCreateOverrides = {},
) {
  return buildSelectedSessionCreateParams(place, {
    ...options,
    message: options.message ?? "",
    toolOverrides: draft.capabilities.toolOverrides,
    permissionMode: draft.permission.value,
    visibility: options.visibility ?? draft.visibility,
    catalogId: snapshot.data?.catalogId,
    category: gateway.resolvedGroupCategory(),
  });
}

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

export function prepareDraftSubmissionTurn(
  context: ApplicationContext,
  input: NonNullable<ReturnType<typeof prepareDraftSubmission>>,
  createdAt: number,
) {
  const { hello, selfUser } = context.gateway.snapshot;
  const sender = resolveCurrentUserIdentity(hello, input.client.instanceId, selfUser) ?? undefined;
  return {
    text: input.message,
    mentions: input.mentions,
    attachments: input.attachments,
    createdAt,
    sender,
  };
}
