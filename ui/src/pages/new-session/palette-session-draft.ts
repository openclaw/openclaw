import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { closeMenusWithin } from "../../components/solid/menu.tsx";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { showToast } from "../../lib/toast.ts";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "../chat/components/chat-attachment-controls.types.ts";
import "../../styles/new-session.css";
import "../../styles/chat/composer.css";
import {
  appendChatAttachmentFiles,
  createChatAttachmentDropHandlers,
  handleChatAttachmentPaste,
} from "../chat/components/chat-attachments.ts";
import { ConnectMachineSetupState } from "./connect-machine-dialog.ts";
import { NewSessionDraft } from "./draft.ts";
import type { NewSessionRouteData } from "./location.ts";
import { resolveNewSessionMentionDirectory } from "./mention-directory.ts";
import { PaletteSessionPreferences } from "./palette-session-preferences.ts";
import { PaletteDraftSlot, PaletteReleasedStarts } from "./palette-session-starts.ts";
import type { PaletteSessionPreference } from "./preferences.ts";
import { captureSessionNoticeOwner, openSessionNoticeTarget } from "./session-notice-owner.ts";
import type { SubmissionPresentation } from "./submission-action.ts";

registerCommandPaletteEnglish();

/** Launcher-local prompt and selections; never binds the full page's durable draft or handoff. */
export class PaletteSessionDraft {
  private submissionLifetimeValue = Promise.withResolvers<void>();
  presentSubmit: SubmissionPresentation["presentSubmit"];
  get submissionLifetime() {
    return this.submissionLifetimeValue.promise;
  }
  private retireSubmissionPresentation() {
    this.submissionLifetimeValue.resolve();
    this.submissionLifetimeValue = Promise.withResolvers<void>();
    this.callbacks.changed();
  }
  setSubmissionError(error: unknown) {
    this.draft?.submission.setError(error instanceof Error ? error.message : String(error));
  }
  private slot: PaletteDraftSlot | undefined;
  private get draft(): NewSessionDraft | undefined {
    return this.slot?.draft;
  }
  private readonly starts = new PaletteReleasedStarts(() => {
    const gateway = this.read().context?.gateway;
    return gateway ? gatewayPresentationScope(gateway) : undefined;
  });
  private attachmentIntent = false;
  private readonly changed = () => {
    const draft = this.draft?.submission.attachmentDraft;
    const previous = this.attachmentIntent;
    // Pending reads establish intent before they have a ready payload.
    this.attachmentIntent = Boolean(
      draft?.reads.project(draft.attachments).length ||
      (this.attachmentIntent && this.message.trim()),
    );
    if (previous !== this.attachmentIntent) {
      this.callbacks.onAttachmentModeChange?.();
    }
    this.callbacks.changed();
  };

  get attachmentMode(): boolean {
    return this.attachmentIntent;
  }

  private presentationScope: ReturnType<typeof gatewayPresentationScope> | undefined;
  private readAgentIdentityTargets: () => readonly string[] = () => [];
  private readonly preferences: PaletteSessionPreferences;
  private closeSettings: (() => void) | undefined;
  private readonly registerSettingsClose = (close: () => void) => {
    this.closeSettings = close;
    return () => {
      this.closeSettings = undefined;
    };
  };
  private coldSubmit: { readSignal?: AbortSignal; failureCount: number } | undefined;
  private owner: { gateway: ApplicationContext["gateway"]; url: string; scope: string } | undefined;
  private readonly connectMachine: ConnectMachineSetupState;
  private static nextId = 0;
  private readonly idPrefix = `palette-session-${++PaletteSessionDraft.nextId}`;

  constructor(
    private readonly element: Pick<HTMLElement, "isConnected" | "ownerDocument" | "contains">,
    private readonly read: () => { context: ApplicationContext | undefined; open: boolean },
    private readonly callbacks: {
      changed: () => void;
      updateComplete: () => Promise<unknown>;
      onClose: () => void;
      onMessageChange?: (message: string) => void;
      onAttachmentModeChange?: () => void;
    },
  ) {
    this.preferences = new PaletteSessionPreferences(
      () => ({ draft: this.draft, context: this.read().context }),
      (preference) => this.restoreSettings(preference),
      callbacks.changed,
    );
    this.connectMachine = new ConnectMachineSetupState(
      () => ({
        client: this.draft?.gateway.client ?? null,
        connected: this.draft?.gateway.connected ?? false,
      }),
      callbacks.changed,
    );
  }

  get message(): string {
    return this.draft?.submission.message ?? "";
  }
  get mentions(): readonly HumanMention[] {
    return this.draft?.submission.mentions ?? [];
  }
  get mentionDirectory() {
    return this.draft && this.read().open && !this.messageLocked
      ? resolveNewSessionMentionDirectory({
          context: this.read().context,
          agentId: this.draft.place.agentId,
          draftOwnerKey: this.idPrefix,
          visibility: this.draft.submission.visibility,
        })
      : undefined;
  }
  get submitting(): boolean {
    return this.draft?.submission.submitting ?? false;
  }
  get messageLocked(): boolean {
    return (
      this.submitting ||
      Boolean(this.coldSubmit || this.draft?.submission.pendingPlacement.sessionKey)
    );
  }
  get hasPrompt(): boolean {
    return Boolean(
      this.message.trim() || this.draft?.submission.attachmentDraft.attachments.length,
    );
  }
  get canSubmit(): boolean {
    return !this.coldSubmit && this.hasPrompt && Boolean(this.draft?.submission.canSubmit());
  }
  get error(): string | null {
    const submission = this.draft?.submission;
    return (
      submission?.error ??
      (submission?.submissionOutcomeUnknown ? submission.submitDisabledReason() : null) ??
      (this.preferences.failed ? t("commandPalette.settingsSaveFailed") : null)
    );
  }
  get disabledReason(): string | undefined {
    return this.draft?.submission.submitDisabledReason();
  }

  setMessage(value: string, mentions?: readonly HumanMention[]) {
    if (!this.draft || this.messageLocked) {
      return;
    }
    if (value !== this.message || (mentions !== undefined && mentions !== this.mentions)) {
      this.draft.submission.clearError();
    }
    this.draft.submission.setMessage(value, mentions);
  }

  attachmentProps(): ChatAttachmentControlsProps | undefined {
    const attachmentDraft = this.draft?.submission.attachmentDraft;
    if (!attachmentDraft) {
      return undefined;
    }
    const readSignal = attachmentDraft.reads.readSignal;
    return {
      uploadConfig: this.read().context?.config,
      attachments: attachmentDraft.attachments,
      attachmentReads: attachmentDraft.reads,
      attachmentLimits: resolveChatAttachmentLimits(
        this.read().context?.gateway.snapshot.hello?.policy,
      ),
      disabled: this.messageLocked,
      getAttachments: () => attachmentDraft.attachments,
      readSignal,
      onPendingReadsChange: (delta) => attachmentDraft.reads.updatePending(readSignal, delta),
      onAttachmentsChange: (attachments) => {
        this.synchronizePresentationScope();
        if (
          readSignal.aborted ||
          this.submitting ||
          this.draft?.submission.pendingPlacement.sessionKey
        ) {
          return;
        }
        this.draft?.submission.clearError();
        attachmentDraft.replace(attachments);
      },
    };
  }

  readonly pasteImages = (event: ClipboardEvent) => {
    this.synchronizePresentationScope();
    const props = this.attachmentProps();
    if (this.read().open && !this.messageLocked && props) {
      handleChatAttachmentPaste(event, props, { imagesOnly: true });
    }
  };

  static createDropHandlers(read: () => PaletteSessionDraft) {
    return createChatAttachmentDropHandlers({
      get canCompose() {
        const owner = read();
        owner.synchronizePresentationScope();
        return owner.read().open && !owner.messageLocked;
      },
      get uploadConfig() {
        return read().read().context?.config;
      },
      get attachments() {
        return read().attachmentProps()?.attachments;
      },
      get attachmentReads() {
        return read().attachmentProps()?.attachmentReads;
      },
      get attachmentLimits() {
        return read().attachmentProps()?.attachmentLimits;
      },
      get readSignal() {
        return read().attachmentProps()?.readSignal;
      },
      getAttachments: () => read().attachmentProps()?.getAttachments?.() ?? [],
      onAttachmentsChange: (attachments) =>
        read().attachmentProps()?.onAttachmentsChange?.(attachments),
      onPendingReadsChange: (delta) => read().attachmentProps()?.onPendingReadsChange?.(delta),
    });
  }

  adoptAttachmentFiles(files: readonly File[], submitRequested = false) {
    const props = this.attachmentProps();
    if (!this.read().open || this.messageLocked || !props) {
      return;
    }
    const failureCount = props.attachmentReads?.failureCount ?? 0;
    const admitted = appendChatAttachmentFiles(files, props);
    if (submitRequested && admitted === files.length) {
      // The loader accepted Send before the readers existed. Carry that one
      // intent across preparation, but never across dismissal or invalidation.
      this.submitCold(props.readSignal, failureCount);
    }
  }

  open() {
    this.synchronizePresentationScope();
    // Reopening cannot abandon a request or turn an uncertain create into a second one.
    if (
      this.draft &&
      (this.attachmentMode ||
        this.submitting ||
        this.draft.submission.pendingPlacement.sessionKey ||
        this.draft.submission.submissionOutcomeUnknown ||
        this.draft.submission.error)
    ) {
      return;
    }
    const context = this.read().context;
    const agentId = context?.agentSelection.state.selectedId ?? "";
    const data = {
      agentId,
      requestedAgentId: agentId,
      catalogId: "",
      catalogLabel: "",
      startTerminal: false,
    };
    if (this.slot) {
      this.slot.data = data;
    } else {
      this.slot = this.createSlot(data);
    }
    const { draft } = this.slot;
    draft.connect();
    this.coldSubmit = undefined;
    draft.place.resetDraft();
    draft.submission.resetDraft();
    draft.place.agentsHydrated = draft.agentsReady();
    this.preferences.begin();
    draft.place.adoptAgentDefaults();
    this.callbacks.changed();
  }

  /** Launcher callbacks act only while this slot is the visible draft; released starts keep their own. */
  private createSlot(data: NewSessionRouteData): PaletteDraftSlot {
    return new PaletteDraftSlot(data, (slot) => this.createDraft(slot));
  }

  private createDraft(slot: PaletteDraftSlot): NewSessionDraft {
    const owns = () => this.slot === slot;
    return new NewSessionDraft(
      () => ({
        context: this.read().context,
        data: slot.data,
        // A closed launcher still owns its submitted transaction until acceptance or failure.
        isConnected: this.element.isConnected,
      }),
      {
        changed: () => {
          this.changed();
          this.starts.observe(slot);
        },
        updateComplete: this.callbacks.updateComplete,
        onMessageChange: (message) => {
          if (owns()) {
            this.callbacks.onMessageChange?.(message);
          }
        },
        activeElement: () => this.element.ownerDocument.activeElement,
        preferenceScope: "palette",
        readPalettePreference: () => this.preferences.selection,
        closeTransientUi: () => {
          slot.draft.browser.close();
          if (owns()) {
            this.closeSettings?.();
            closeMenusWithin(this.element);
          }
        },
        onInvalidate: () => {
          if (owns()) {
            this.retireSubmissionPresentation();
            this.preferences.retirePresentation();
            this.connectMachine.close();
          }
        },
        onRecoveryReady: (url, scope) => {
          if (owns()) {
            this.bindOwner(url, scope);
          }
        },
        onAccepted: (result) => {
          slot.accepted = true;
          this.accepted(result);
        },
      },
    );
  }

  close() {
    this.retireSubmissionPresentation();
    this.preferences.retirePresentation();
    this.coldSubmit = undefined;
    // Dismissal hides the launcher, not its new-session draft. Reads retain their
    // original custody until completion, owner replacement, or disconnect.
    this.closeSettings?.();
    this.draft?.browser.close();
    this.connectMachine.close();
    closeMenusWithin(this.element);
  }

  submit(): Promise<void> {
    const operation = () => this.submitOwnedDraft();
    return this.presentSubmit ? this.presentSubmit(operation) : operation();
  }

  private async submitOwnedDraft(): Promise<void> {
    this.synchronizePresentationScope();
    const slot = this.slot;
    if (!this.read().open || this.coldSubmit || this.submitting || !this.hasPrompt || !slot) {
      return;
    }
    const submission = slot.draft.submission.submit(undefined, true);
    // Local admission is synchronous. Once past it, the start owns its draft and the
    // launcher is free for the next prompt; acceptance or failure arrives as a notice.
    if (slot.draft.submission.submitting) {
      this.release(slot);
    }
    await submission;
  }

  private release(slot: PaletteDraftSlot) {
    if (this.read().open) {
      this.callbacks.onClose();
    }
    this.slot = undefined;
    this.starts.adopt(slot);
    this.callbacks.onMessageChange?.("");
    this.changed();
  }

  submitCold(
    readSignal?: AbortSignal,
    failureCount = this.draft?.submission.attachmentDraft.reads.failureCount ?? 0,
  ) {
    this.coldSubmit = { readSignal, failureCount };
    this.callbacks.changed();
  }

  connect() {
    this.draft?.connect();
  }

  synchronize() {
    this.synchronizePresentationScope();
    this.draft?.synchronize();
    this.starts.synchronize();
  }

  private synchronizePresentationScope() {
    const gateway = this.read().context?.gateway;
    const scope = gateway ? gatewayPresentationScope(gateway) : undefined;
    const replaced = this.presentationScope !== undefined && this.presentationScope !== scope;
    this.presentationScope = scope;
    if (!replaced) {
      return;
    }
    // Retire the submission through its existing owner before replacing text.
    // A pending prompt must not reappear when a different connection opens Cmd+K.
    this.close();
    this.starts.discard();
    this.owner = undefined;
    this.draft?.gateway.invalidateDiscovery(true, "gateway-changed");
    this.draft?.submission.releasePendingPlacementOwner();
    this.draft?.submission.resetDraft();
    this.draft?.submission.restoreMessage("");
    this.callbacks.onMessageChange?.("");
  }

  settled() {
    this.starts.settled();
    const draft = this.draft;
    if (!draft) {
      return;
    }
    if (this.connectMachine.open && !draft.place.isAdmin()) {
      this.connectMachine.close();
    }
    this.preferences.synchronize();
    draft.synchronizeSelections();
    draft.submission.synchronizeSubmission();
    const attachmentDraft = draft.submission.attachmentDraft;
    const pending = this.coldSubmit;
    if (
      pending &&
      (!pending.readSignal ||
        attachmentDraft.reads.pendingReads === 0 ||
        pending.readSignal.aborted)
    ) {
      const failed =
        pending.readSignal &&
        (pending.readSignal.aborted || attachmentDraft.reads.failureCount !== pending.failureCount);
      if (failed || draft.gateway.placementPolicyReady) {
        this.coldSubmit = undefined;
        this.callbacks.changed();
        if (!failed) {
          void this.submit();
        }
      }
    }
    if (this.read().open) {
      void this.read().context?.agentIdentity.ensure([
        ...new Set([draft.place.agentId, ...this.readAgentIdentityTargets()]),
      ]);
    }
  }

  disconnect() {
    this.close();
    this.starts.discard();
    this.draft?.submission.attachmentDraft.reset();
    this.attachmentIntent = false;
    this.draft?.disconnect();
  }

  settingsView() {
    const draft = this.draft;
    if (!draft) {
      return undefined;
    }
    return {
      id: this.idPrefix,
      registerClose: this.registerSettingsClose,
      options: {
        draft,
        context: this.read().context,
        preferences: this.preferences,
        identityTargetsRef: (read: () => readonly string[]) => {
          this.readAgentIdentityTargets = read;
        },
        onIdentityTargetsChange: () => this.callbacks.changed(),
        onChange: () => this.preferences.changed(),
        onConnectMachine: () => {
          if (draft.place.isAdmin()) {
            this.closeSettings?.();
            draft.browser.close();
            this.connectMachine.start();
          }
        },
      },
    };
  }

  private restoreSettings(preference: PaletteSessionPreference | null) {
    const slot = this.slot;
    if (!slot || this.messageLocked) {
      return;
    }
    const defaultAgent = this.read().context?.agentSelection.state.selectedId ?? "";
    const agentId = preference?.agentId ?? defaultAgent;
    slot.data = { ...slot.data, agentId, requestedAgentId: agentId };
    slot.draft.place.resetDraft();
    slot.draft.place.agentsHydrated = slot.draft.agentsReady();
    slot.draft.place.adoptAgentDefaults();
    slot.draft.place.restorePreferenceSelections();
  }

  auxiliaryView() {
    return this.connectMachine.view(
      this.read().open && (this.draft?.place.isAdmin() ?? false),
      () => {
        this.callbacks.onClose();
        this.read().context?.navigate("devices");
      },
    );
  }

  private bindOwner(url: string, scope: string) {
    const gateway = this.read().context?.gateway;
    if (!gateway) {
      return;
    }
    if (
      this.owner &&
      (this.owner.gateway !== gateway || this.owner.url !== url || this.owner.scope !== scope)
    ) {
      this.draft?.submission.restoreMessage("");
    }
    this.owner = { gateway, url, scope };
  }

  private accepted(result: SessionCreateOutcome & { agentId: string }) {
    const context = this.read().context;
    if (!context) {
      return;
    }
    const isCurrentOwner = captureSessionNoticeOwner(context);
    const row = context.sessions.state.result?.sessions.find(
      (candidate) => candidate.key === result.key,
    );
    const status =
      result.initialRun.status === "rejected"
        ? result.initialRun.error
        : t(
            result.initialRun.status === "started"
              ? "sessionsView.statusRunning"
              : "sessionsView.statusIdle",
          );
    const openSession = () => {
      if (this.read().context !== context || !isCurrentOwner()) {
        return;
      }
      openSessionNoticeTarget(context, result.key, result.agentId);
      // The destination owns a rejected first turn and its retry; dismiss the launcher over it.
      if (this.read().open) {
        this.callbacks.onClose();
      }
    };
    showToast({
      fifo: true,
      message: `${resolveSessionDisplayName(result.key, row)}: ${status}`,
      actionLabel: t("sessionsView.openSession"),
      onAction: openSession,
    });
  }
}
