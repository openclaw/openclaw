import type { ApplicationContext } from "../../app/context.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { reviewPrivateComposerDraft } from "../chat/components/private-composer-recovery-dialog.ts";
import * as catalog from "./catalog-target.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionRouteData } from "./location.ts";

const NEW_SESSION_DRAFT_PANE_ID = "new-session-draft";

export function prepareTargetTransition(
  context: ApplicationContext,
  data: NewSessionRouteData,
  isCurrent: () => boolean,
) {
  return context.chatAttachmentHandoff.prepare({
    owner: context.gateway.snapshot.client,
    paneId: NEW_SESSION_DRAFT_PANE_ID,
    scopeKey: catalog.routeKey(data),
    reviewPrivateDraft: reviewPrivateComposerDraft,
    // The mounted composer retains payload custody until an actual teardown.
    attachments: [],
    newSessionTarget: { data, isCurrent },
    fallbacks: {},
  });
}

export function preparedTarget(context: ApplicationContext, search: string) {
  return context.chatAttachmentHandoff.peekNewSessionTarget({
    owner: context.gateway.snapshot.client,
    paneId: NEW_SESSION_DRAFT_PANE_ID,
    scopeKey: catalog.routeKeyFromSearch(search),
  });
}

export function completeTargetTransition(
  context: ApplicationContext,
  submission: DraftSubmissionFlow,
  routeKey: string,
) {
  const draft = context.chatAttachmentHandoff.consume({
    owner: context.gateway.snapshot.client,
    paneId: NEW_SESSION_DRAFT_PANE_ID,
    scopeKey: routeKey,
  });
  if (!draft?.newSessionTarget?.isCurrent()) {
    return false;
  }
  // A picker move starts a new mutation in the destination, never transfers CAS lineage.
  void submission.draftPersistence.retireActive();
  submission.draftPersistence.selectRoute(routeKey);
  submission.draftPersistence.noteDraftReplaced();
  submission.draftPersistence.noteUserMutation();
  activateDraft(submission, routeKey);
  return true;
}

export function retainDraft(
  context: ApplicationContext | undefined,
  submission: DraftSubmissionFlow,
  openedFor: string | null,
  messageOwnerKey: string,
  destinationKey?: string,
) {
  submission.draftPersistence.persistNow();
  const owner = context?.gateway.snapshot.client;
  if (!context || !owner || submission.submitting || submission.pendingPlacement.sessionKey) {
    return;
  }
  const routeKey = openedFor ?? catalog.routeKeyFromSearch(window.location.search);
  context.chatAttachmentHandoff.prepare({
    reviewPrivateDraft: reviewPrivateComposerDraft,
    owner,
    paneId: NEW_SESSION_DRAFT_PANE_ID,
    scopeKey: destinationKey ?? routeKey,
    message: messageOwnerKey === routeKey ? submission.message : "",
    mentions: messageOwnerKey === routeKey ? submission.mentions : undefined,
    newSessionDraft: submission.draftPersistence.captureSubmission(),
    ...(destinationKey && destinationKey !== routeKey
      ? { newSessionDraftTransfer: true as const }
      : {}),
    attachments: submission.attachmentDraft.take(),
    fallbacks: {},
  });
  if (destinationKey && destinationKey !== routeKey) {
    void submission.draftPersistence.retireActive();
  }
}

export function restoreDraft(
  context: ApplicationContext | undefined,
  submission: DraftSubmissionFlow,
  routeKey: string,
  ownedMessage: string,
  ownedMentions?: readonly HumanMention[],
) {
  const owner = context?.gateway.snapshot.client;
  if (context && owner?.recoveryScopeReady) {
    submission.draftPersistence.setOwner(
      context.gateway.connection.gatewayUrl,
      owner.recoveryScope,
      true,
    );
  }
  submission.draftPersistence.selectRoute(routeKey);
  const draft =
    context && owner
      ? context.chatAttachmentHandoff.consume({
          owner,
          paneId: NEW_SESSION_DRAFT_PANE_ID,
          scopeKey: routeKey,
        })
      : null;
  if (draft) {
    submission.restoreDraftState({
      message: ownedMessage || draft.message || "",
      mentions: ownedMessage ? ownedMentions : draft.mentions,
      attachments: draft.attachments,
      visibility: draft.newSessionDraft?.incognito ? "incognito" : submission.visibility,
    });
    if (draft.newSessionDraftTransfer) {
      submission.draftPersistence.noteUserMutation();
    } else if (!ownedMessage && draft.newSessionDraft) {
      submission.draftPersistence.adoptHandoff(draft.newSessionDraft);
    }
  } else if (ownedMessage) {
    submission.restoreMessage(ownedMessage, ownedMentions);
  }
  activateDraft(submission, routeKey);
  return routeKey;
}

export function activateDraft(submission: DraftSubmissionFlow, routeKey: string) {
  if (!submission.pendingPlacement.sessionKey) {
    submission.draftPersistence.activateRoute(routeKey);
  }
}

export function restoreDraftOwner(
  submission: DraftSubmissionFlow,
  gatewayUrl: string,
  recoveryScope: string,
) {
  submission.restorePendingPlacementRecovery(gatewayUrl, recoveryScope);
  submission.draftPersistence.setOwner(
    gatewayUrl,
    recoveryScope,
    Boolean(submission.pendingPlacement.sessionKey),
  );
}
