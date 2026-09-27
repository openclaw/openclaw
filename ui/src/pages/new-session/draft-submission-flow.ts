import type { ProjectsAddResult } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import type { SessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "../chat/composer-persistence.ts";
import type { buildLocalUserMessage } from "../chat/user-message-content.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { promptNewSessionNotifications } from "./background-session-notice.ts";
import { NewSessionCapabilityController } from "./capability-controller.ts";
import * as catalog from "./catalog-target.ts";
import { NewSessionComposerTextareaController } from "./composer-controller.ts";
import type { DraftSessionCreateOverrides, NewSessionVisibility } from "./create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { NewSessionDraftPersistence } from "./draft-persistence.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import {
  completeDraftSessionPlacement,
  projectDraftSessionPlacementRecovery,
  resolveDraftSessionPlacement,
} from "./draft-session-placement.ts";
import { DraftSessionStartup, type DraftStartupResumption } from "./draft-session-startup.ts";
import type {
  DraftSubmissionCallbacks,
  DraftSubmissionSnapshot,
} from "./draft-submission-contract.ts";
import {
  buildDraftSubmissionCreateParams,
  prepareDraftSubmission,
  prepareDraftSubmissionTurn,
} from "./draft-submission-input.ts";
import { completeInitialSessionTurn } from "./initial-session-turn-handoff.ts";
import {
  type InstantThreadHandoff,
  prepareInstantThreadHandoff,
} from "./instant-thread-handoff.ts";
import { NewSessionPermissionSelection } from "./permission-selection.ts";
import {
  PendingSessionPlacementRecoveryState,
  type SubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";
import {
  PAGE_RENDERED_GATES,
  readNewSessionSubmissionAccess,
  requiresNewSessionModelSetup,
  resolveNewSessionSubmitBlock,
  type NewSessionSubmitBlock,
} from "./submit-gates.ts";
import { submitDraftInTerminal } from "./terminal-start.ts";

registerNewSessionSetupEnglish();
type SubmittedDraft = ReturnType<NewSessionDraftPersistence["captureSubmission"]>;

export class DraftSubmissionFlow {
  private visibilityValue: NewSessionVisibility = "normal";
  private messageText = "";

  private get messageValue(): string {
    return this.messageText;
  }

  private set messageValue(message: string) {
    if (message === this.messageText) {
      return;
    }
    this.messageText = message;
    // Search is a projection of this draft. Owner changes and acceptance must
    // retire its pending query just like an explicit edit does.
    this.callbacks.onMessageChange?.(message);
  }
  private mentionsValue: readonly HumanMention[] = [];
  private activeSubmission: {
    phase: "creating" | "accepted";
    message: ReturnType<typeof buildLocalUserMessage>;
  } | null = null;
  private blockedSubmitGate: string | null = null;
  private rejectedPromptError: string | null = null;
  submissionOutcomeUnknown: SubmissionOutcomeReason | null = null;
  private readonly startedSession = new StartedSessionNavigation();
  error: string | null = null;
  private submitRequestToken = 0;
  private readonly sessionStartup: DraftSessionStartup;
  readonly pendingPlacement = new PendingSessionPlacementRecoveryState(() => this.read().context);
  readonly attachmentDraft: NewSessionAttachmentDraft;
  readonly composerTextarea = new NewSessionComposerTextareaController();
  readonly permission = new NewSessionPermissionSelection(() => this.callbacks.requestUpdate());
  readonly draftPersistence: NewSessionDraftPersistence;
  readonly capabilities: NewSessionCapabilityController;

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly place: DraftPlaceState,
    private readonly read: () => DraftSubmissionSnapshot,
    private readonly callbacks: DraftSubmissionCallbacks,
  ) {
    this.capabilities = new NewSessionCapabilityController(callbacks.requestUpdate);
    this.capabilities.setMutationCallback(() => (this.startedSession.current = null));
    this.permission.setMutationCallback(() => (this.startedSession.current = null));
    this.sessionStartup = new DraftSessionStartup(gateway);
    this.draftPersistence = new NewSessionDraftPersistence(
      () => ({
        message: this.messageValue,
        mentions: this.mentionsValue,
        attachments: this.attachmentDraft.attachments,
        incognito: this.visibilityValue === "incognito",
      }),
      (message, attachments, resetVisibility, mentions) => {
        this.restoreDraftState({
          message,
          mentions,
          attachments,
          visibility: resetVisibility ? "normal" : this.visibilityValue,
        });
      },
      () => this.setError(CHAT_COMPOSER_DRAFT_STORAGE_ERROR),
    );
    this.attachmentDraft = new NewSessionAttachmentDraft(callbacks.requestUpdate, () => {
      this.rejectedPromptError = null;
      this.startedSession.current = null;
      this.draftPersistence.noteUserMutation();
    });
  }

  get visibility(): NewSessionVisibility {
    return this.visibilityValue;
  }

  get message(): string {
    return this.messageValue;
  }

  get mentions(): readonly HumanMention[] {
    return this.mentionsValue;
  }

  get submitting(): boolean {
    return this.activeSubmission !== null || this.sessionStartup.active;
  }

  get pendingMessage() {
    return this.activeSubmission?.message ?? this.completedSubmission?.message ?? null;
  }

  get completedSubmission() {
    return !this.activeSubmission ? this.startedSession.submission(this.read().context) : null;
  }

  openSubmittedSession() {
    return this.startedSession.openSubmission(this.read().context, this.completedSubmission, {
      capture: () => {
        const requestId = ++this.submitRequestToken;
        return () => requestId === this.submitRequestToken;
      },
      publish: (message, error) => {
        this.activeSubmission = message ? { phase: "accepted", message } : null;
        if (error !== undefined) {
          this.error = error;
        }
        this.callbacks.requestUpdate();
      },
    });
  }

  resumeInterruptedSubmission() {
    const startup = this.sessionStartup.resume();
    if (startup.kind === "resume") {
      void this.submit(startup);
    } else if (startup.kind !== "wait") {
      this.activeSubmission = null;
      this.submissionOutcomeUnknown = "gateway-changed";
      this.callbacks.requestUpdate();
    }
  }

  setMessage(message: string, mentions?: readonly HumanMention[]) {
    if (message !== this.messageValue) {
      this.rejectedPromptError = null;
    }
    this.startedSession.current = null;
    this.mentionsValue =
      mentions ?? updateHumanMentions(this.messageValue, message, this.mentionsValue);
    this.messageValue = message;
    this.draftPersistence.noteUserMutation();
    this.callbacks.requestUpdate();
  }

  restoreMessage(message: string, mentions: readonly HumanMention[] = []) {
    this.rejectedPromptError = null;
    this.draftPersistence.noteDraftReplaced();
    this.messageValue = message;
    this.mentionsValue = mentions;
    this.callbacks.requestUpdate();
  }

  restoreDraftState(state: {
    message: string;
    mentions?: readonly HumanMention[];
    attachments: ChatAttachment[];
    visibility: NewSessionVisibility;
    toolOverrides?: NewSessionCapabilityController["toolOverrides"];
    permissionMode?: SessionCreateParams["permissionMode"];
  }) {
    this.draftPersistence.noteDraftReplaced();
    this.messageValue = state.message;
    this.mentionsValue = state.mentions ?? [];
    this.visibilityValue = state.visibility;
    this.capabilities.restoreToolOverrides(state.toolOverrides);
    if ("permissionMode" in state) {
      this.permission.restore(state.permissionMode);
    }
    this.attachmentDraft.restore(state.attachments);
  }

  setVisibility(visibility: NewSessionVisibility) {
    this.startedSession.current = null;
    const wasIncognito = this.visibilityValue === "incognito";
    const publish = this.callbacks.requestUpdate;
    this.visibilityValue = visibility;
    this.draftPersistence.transitionIncognito(wasIncognito, visibility === "incognito", publish);
  }

  setError(error: string | null) {
    if (error !== null || this.error === t("newSession.cloudRecoveryUnavailable")) {
      this.error = error;
    }
    this.callbacks.requestUpdate();
  }

  clearError(expected?: string) {
    if (expected !== undefined && this.error !== expected) {
      return;
    }
    this.error = null;
    this.callbacks.requestUpdate();
  }

  markPendingPlacementUnavailable(outcome: SubmissionOutcomeReason) {
    this.pendingPlacement.retryAllowed = false;
    this.submissionOutcomeUnknown = outcome;
    this.callbacks.requestUpdate();
  }

  /** A submit was attempted (Enter or Start click) while a gate blocked it. */
  noteBlockedSubmitAttempt() {
    this.blockedSubmitGate = this.submitBlock()?.gate ?? null;
    this.callbacks.requestUpdate();
  }

  /** Attempt-bound reason that retires when its transient gate lifts. */
  blockedSubmitNotice(): string | undefined {
    const block = this.blockedSubmitGate ? this.submitBlock() : undefined;
    return block?.gate === this.blockedSubmitGate && !PAGE_RENDERED_GATES.has(block.gate)
      ? block.reason
      : undefined;
  }

  private buildDraftSessionCreateParams = (options: DraftSessionCreateOverrides = {}) =>
    buildDraftSubmissionCreateParams(this.place, this.gateway, this, this.read(), options);

  submissionAccess = (
    createParams: Record<string, unknown> = this.pendingPlacement.createParams ??
      this.buildDraftSessionCreateParams(),
  ): SessionMethodAccess =>
    readNewSessionSubmissionAccess({
      gateway: this.read().context?.gateway.snapshot,
      place: this.place,
      pendingPlacement: this.pendingPlacement,
      hasInitialTurn: Boolean(this.messageValue.trim() || this.attachmentDraft.attachments.length),
      createParams,
    });

  submitDisabledReason = (): string | undefined => this.submitBlock()?.reason;

  incognitoDisabledReason(): string | undefined {
    const access = readSessionMethodAccess(this.read().context?.gateway.snapshot, {
      method: "sessions.create",
      params: this.buildDraftSessionCreateParams({ visibility: "incognito" }),
    });
    return access.allowed ? undefined : access.reason;
  }

  canSubmit = (): boolean => this.submitBlock() === undefined;

  /** Single owner for submit state, tooltips, and blocked-Enter notices. */
  submitBlock(): NewSessionSubmitBlock | undefined {
    if (this.rejectedPromptError) {
      return { gate: "initial-turn-rejected", reason: this.rejectedPromptError };
    }
    if (
      !catalog.isTarget(this.read().data) &&
      this.attachmentDraft.pendingReads === 0 &&
      this.startedSession.isCurrent(this.read().context, this.place.agentId)
    ) {
      return this.activeSubmission ? { gate: "submitting" } : undefined;
    }
    return resolveNewSessionSubmitBlock({
      gatewayState: this.gateway,
      placeState: this.place,
      pendingPlacement: this.pendingPlacement,
      submitting: this.activeSubmission !== null,
      message: this.messageValue,
      submissionOutcomeUnknown: this.submissionOutcomeUnknown,
      pendingAttachmentReads: this.attachmentDraft.pendingReads,
      hasDraftAttachments: this.attachmentDraft.attachments.length > 0,
      hasCapabilityOverrides: this.capabilities.toolOverrides !== null,
      mentions: this.mentionsValue,
      visibility: this.visibilityValue,
      submissionSnapshot: () => this.read(),
      requiresModelSetup: () => this.requiresModelSetup(),
      submissionAccess: () => this.submissionAccess(),
      placementTargetForSubmission: () => this.placement().target,
      cloudRuntimeUnsupportedReason: () =>
        this.place.modelControl.cloudRuntimeUnsupportedReason(
          this.gateway.cloudProfiles.find((profile) => profile.id === this.place.cloudProfileId),
        ),
    });
  }

  requiresModelSetup = (): boolean =>
    requiresNewSessionModelSetup({
      snapshot: this.read(),
      gateway: this.gateway,
      place: this.place,
      pendingPlacement: this.pendingPlacement,
    });

  invalidate(outcomeUnknown: SubmissionOutcomeReason | null = null) {
    this.submitRequestToken += 1;
    this.startedSession.current = null;
    const creating = this.activeSubmission?.phase === "creating";
    const interrupted = outcomeUnknown !== null && creating && this.sessionStartup.interrupt();
    if ((outcomeUnknown && creating && !interrupted) || this.sessionStartup.retireChangedOwner()) {
      this.submissionOutcomeUnknown = outcomeUnknown;
    }
    // A recoverable reconnect still owns the submission; do not flash the draft
    // while the same frozen create request waits to resume.
    if (!interrupted) {
      this.activeSubmission = null;
    }
    this.callbacks.requestUpdate();
  }

  resetDraft() {
    this.startedSession.clearSubmission();
    this.rejectedPromptError = null;
    this.sessionStartup.clear();
    const preservePendingPlacement = Boolean(this.pendingPlacement.sessionKey);
    this.blockedSubmitGate = null;
    this.invalidate();
    this.submissionOutcomeUnknown = preservePendingPlacement
      ? (this.submissionOutcomeUnknown ?? "placement-interrupted")
      : null;
    this.visibilityValue = "normal";
    this.capabilities.reset();
    this.permission.reset();
    this.attachmentDraft.reset({ release: true });
    if (preservePendingPlacement) {
      if (!this.pendingPlacement.restored) {
        this.pendingPlacement.retryAllowed = false;
      }
      this.applyRecoveryDraft(this.pendingPlacement.capture());
      this.pendingPlacement.restored = false;
    } else {
      this.clearPendingPlacementRecovery();
      this.draftPersistence.noteDraftReplaced();
      this.messageValue = "";
      this.mentionsValue = [];
    }
    this.clearError();
  }

  clearPendingPlacementRecovery() {
    this.pendingPlacement.clear();
    this.submissionOutcomeUnknown = null;
    this.callbacks.requestUpdate();
  }

  releasePendingPlacementOwner() {
    this.pendingPlacement.reset();
    this.submissionOutcomeUnknown = null;
    this.callbacks.requestUpdate();
  }

  restorePendingPlacementRecovery(gatewayUrl: string, recoveryScope: string) {
    this.applyRecoveryDraft(this.pendingPlacement.restore(gatewayUrl, recoveryScope));
  }

  async submit(startup?: DraftStartupResumption, backgroundRequested = false) {
    if (!startup && catalog.isTarget(this.read().data)) {
      return this.startInTerminal();
    }
    const background =
      startup?.background ?? (backgroundRequested && this.visibilityValue !== "draft");
    const context = this.read().context;
    if (!context || (!startup && !this.canSubmit())) {
      this.noteBlockedSubmitAttempt();
      return;
    }
    const preparedTitle = this.callbacks.takePreparedTitle?.();
    this.blockedSubmitGate = null;
    const input = prepareDraftSubmission(context, this, this.place, startup, background);
    if (!input) {
      return;
    }
    const requestId = ++this.submitRequestToken;
    const submittedDraft = this.draftPersistence.captureSubmission();
    const submittedAt = startup?.startedAt ?? Date.now();
    const turn = prepareDraftSubmissionTurn(context, input, submittedAt);
    const submittedMessage = this.startedSession.messageForTurn(context, this.place.agentId, turn);
    const retainSubmittedSession = this.startedSession.captureSubmission(
      context,
      input.agentId,
      submittedMessage,
      () => requestId === this.submitRequestToken,
    );
    // The draft keeps custody until creation succeeds; this snapshot only makes
    // foreground submission visible while the Gateway is still admitting it.
    this.activeSubmission = {
      phase: "creating",
      message: submittedMessage,
    };
    this.error = null;
    this.place.browser.close();
    this.callbacks.closeTransientUi();
    this.callbacks.requestUpdate();
    let instant: InstantThreadHandoff | undefined;
    try {
      const started = this.startedSession.current;
      if (started && this.startedSession.isCurrent(context, this.place.agentId)) {
        await this.startedSession.navigate(context, started);
        return;
      }
      this.startedSession.current = null;
      const placementTarget = startup ? null : this.placement().target;
      promptNewSessionNotifications(
        context,
        input.message,
        Boolean(input.apiAttachments?.length),
        !startup && !input.pendingPlacement,
      );
      const remoteProject =
        !startup && !input.pendingPlacement && !placementTarget && !input.hasInitialTurn
          ? this.place.browser.remoteProject
          : null;
      if (remoteProject && !remoteProject.projectId && !this.place.browser.projectId) {
        const project = await input.client.request<ProjectsAddResult>(
          "projects.add",
          { gitUrl: remoteProject.cloneUrl },
          { timeoutMs: null },
        );
        if (requestId !== this.submitRequestToken || this.gateway.client !== input.client) {
          return;
        }
        this.place.browser.recordRemoteProjectId(remoteProject.cloneUrl, project.id);
      }
      const createParams =
        startup?.params ??
        this.buildDraftSessionCreateParams({
          message: input.message,
          mentions: input.mentions,
          displayName: preparedTitle,
          visibility:
            this.visibilityValue === "draft" &&
            !this.capabilities.canStartAsDraft(this.read().context)
              ? "normal"
              : this.visibilityValue,
          attachments: input.draftAttachments,
        });
      const beginInstant = prepareInstantThreadHandoff({
        context,
        params: createParams,
        resumed: Boolean(startup),
        enabled: !background && !placementTarget,
        agentId: input.agentId,
        retainDraft: this.callbacks.retainForHandoff,
        message: this.pendingMessage,
      });
      const placementCreateParams = placementTarget
        ? input.pendingPlacement
          ? this.pendingPlacement.createParams
          : this.pendingPlacement.stageCreate({
              agentId: input.agentId,
              target: placementTarget,
              message: input.message,
              mentions: input.mentions,
              attachments: input.apiAttachments,
              gatewayUrl: input.gatewayUrl,
              recoveryScope: input.recoveryScope,
              createParams,
              persistent: this.visibilityValue !== "incognito",
            })
        : undefined;
      const requestAccess = startup
        ? readSessionMethodAccess(context.gateway.snapshot, {
            method: "sessions.create",
            params: createParams,
            sessionScope: true,
          })
        : this.submissionAccess(placementCreateParams ?? createParams);
      if (!requestAccess.allowed) {
        this.sessionStartup.clear();
        this.error = requestAccess.reason;
        return;
      }
      const submissionPlacementRecovery = placementTarget ? this.pendingPlacement.capture() : null;
      if (placementTarget && !submissionPlacementRecovery) {
        this.setPlacementRecoveryUnavailable();
        return;
      }
      const createRequest =
        input.pendingPlacement && this.pendingPlacement.phase !== "creating"
          ? Promise.resolve({
              key: this.pendingPlacement.sessionKey,
              initialRun: { status: "idle" as const },
            })
          : context.sessions.createResult(
              placementCreateParams ??
                startup?.params ??
                this.sessionStartup.start(createParams, background),
              { reconciliation: "background" },
            );
      instant = beginInstant?.();
      const result = await createRequest;
      if (result && !placementTarget && result.initialRun.status !== "rejected") {
        await input.consumeWorktreeName?.();
      }
      if (requestId !== this.submitRequestToken && !placementTarget) {
        // Leaving the view cancels navigation, not a confirmed send. Retire only
        // the captured source draft; the current route may already hold new input.
        if (result && result.initialRun.status !== "rejected") {
          await this.clearSubmittedDraft(true, submittedDraft, false);
        }
        return;
      }
      if (!result) {
        if (requestId !== this.submitRequestToken) {
          return;
        }
        this.sessionStartup.clear();
        this.error = context.sessions.state.error ?? t("newSession.createFailed");
        if (instant) {
          await instant.rollback();
        }
        return;
      }
      if (placementTarget && submissionPlacementRecovery) {
        await completeDraftSessionPlacement({
          context,
          client: input.client,
          agentId: input.agentId,
          pending: this.pendingPlacement,
          submittedRecovery: submissionPlacementRecovery,
          sessionKey: result.key,
          createdAt: submittedAt,
          isRequestCurrent: () => requestId === this.submitRequestToken,
          isLifecycleCurrent: () =>
            this.read().isConnected &&
            input.client.recoveryScopeReady &&
            requestId === this.submitRequestToken &&
            this.gateway.client === input.client &&
            this.gateway.gatewayUrl === input.gatewayUrl &&
            this.gateway.recoveryScope === input.recoveryScope,
          clearRecovery: () => this.clearPendingPlacementRecovery(),
          setError: (error) => this.setError(error),
          onRecoveryUnavailable: () => this.setPlacementRecoveryUnavailable(),
          clearDraft: () => {
            retainSubmittedSession(result.key);
            return this.clearSubmittedDraft(true, submittedDraft);
          },
          consumeWorktreeName: input.consumeWorktreeName,
          completeInBackground: input.completeInBackground,
          onAccepted: () => this.callbacks.onAccepted?.({ ...result, agentId: input.agentId }),
          navigate: () =>
            this.startedSession.navigate(context, {
              client: input.client,
              key: result.key,
              agentId: input.agentId,
            }),
        });
        return;
      }
      await completeInitialSessionTurn({
        onRejectedPrompt:
          background && this.callbacks.retainRejectedPrompt
            ? (error) => {
                this.rejectedPromptError = error;
                this.error = error;
                this.sessionStartup.clear();
              }
            : undefined,
        context,
        client: input.client,
        agentId: input.agentId,
        result,
        turn,
        instant,
        navigation: this.startedSession,
        isCurrent: () => requestId === this.submitRequestToken,
        clearDraft: (release, keepPending) => {
          if (keepPending !== false) {
            retainSubmittedSession(
              result.key,
              result.initialRun.status === "rejected" ? result.initialRun.error : undefined,
            );
          }
          return this.clearSubmittedDraft(release, submittedDraft, keepPending);
        },
        completeInBackground: input.completeInBackground,
        onAccepted: () => this.callbacks.onAccepted?.({ ...result, agentId: input.agentId }),
        finishNavigation: () => this.sessionStartup.clear(),
      });
    } catch (error) {
      if (requestId === this.submitRequestToken && this.gateway.client === input.client) {
        this.sessionStartup.clear();
        this.error = error instanceof Error ? error.message : String(error);
        if (instant) {
          await instant.rollback();
        }
      }
    } finally {
      if (instant) {
        await instant.finish();
      }
      if (requestId === this.submitRequestToken) {
        this.activeSubmission = null;
        this.callbacks.requestUpdate();
      }
    }
  }

  private startInTerminal() {
    return submitDraftInTerminal({
      snapshot: this.read(),
      place: this.place,
      flow: this,
      closeTransientUi: this.callbacks.closeTransientUi,
      capture: (client) => {
        this.blockedSubmitGate = null;
        this.error = null;
        const requestId = ++this.submitRequestToken;
        const submitted = this.draftPersistence.captureSubmission();
        const isRequestCurrent = () => requestId === this.submitRequestToken;
        return {
          isRequestCurrent,
          isCurrent: () => isRequestCurrent() && this.gateway.client === client,
          publish: (message, active) => {
            this.activeSubmission = active ? { phase: "creating", message } : null;
            this.callbacks.requestUpdate();
          },
          consume: () => {
            this.startedSession.current = null;
            return this.clearSubmittedDraft(true, submitted);
          },
        };
      },
    });
  }

  private clearSubmittedDraft(releasePayloads: boolean, draft: SubmittedDraft, keepPending = true) {
    return this.draftPersistence.clearSubmittedDraft(draft, () => {
      // Acceptance consumes only the captured mutation, not a newer route's input.
      if (!keepPending) {
        this.activeSubmission = null;
      } else if (this.activeSubmission) {
        this.activeSubmission.phase = "accepted";
      }
      this.messageValue = "";
      this.mentionsValue = [];
      this.draftPersistence.noteDraftReplaced();
      this.attachmentDraft.clearAfterSubmit(releasePayloads);
      this.sessionStartup.clear();
    });
  }

  disconnect() {
    this.pendingPlacement.releaseClaim();
    this.startedSession.current = null;
    this.draftPersistence.disconnect();
    this.attachmentDraft.reset({ release: true });
    this.composerTextarea.disconnect();
  }

  private placement = () => resolveDraftSessionPlacement(this.pendingPlacement, this.place);

  private setPlacementRecoveryUnavailable() {
    this.error = t("newSession.placementStartFailed", {
      error: "placement recovery storage is unavailable",
    });
  }

  private applyRecoveryDraft(recovery: SessionPlacementRecovery | null) {
    if (!recovery) {
      return;
    }
    const projection = projectDraftSessionPlacementRecovery(recovery);
    this.place.applyPendingPlacement(projection.placement);
    this.restoreDraftState(projection.draft);
  }
}
