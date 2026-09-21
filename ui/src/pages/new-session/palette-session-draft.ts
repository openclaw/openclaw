import { html, nothing, type ReactiveController } from "lit";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { showToast } from "../../lib/toast.ts";
import type { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../components/web-awesome-popover.ts";
import "../../styles/new-session.css";
import "../../styles/chat/composer.css";
import type { ChatAttachmentControlsProps } from "../chat/components/chat-attachment-controls.types.ts";
import {
  appendChatAttachmentFiles,
  handleChatAttachmentPaste,
  renderAttachmentPreview,
} from "../chat/components/chat-attachments.ts";
import { ConnectMachineSetupState, renderConnectMachineDialog } from "./connect-machine-dialog.ts";
import { NewSessionDraftController } from "./draft-controller.ts";
import type { NewSessionRouteData } from "./location.ts";
import { resolveNewSessionMentionDirectory } from "./mention-directory.ts";
import { closeSessionMenus } from "./new-session-runtime.ts";
import { PaletteSessionPreferences } from "./palette-session-preferences.ts";
import { PaletteSessionSettings } from "./palette-session-settings.ts";
import type { PaletteSessionPreference } from "./preferences.ts";

registerCommandPaletteEnglish();

/** Launcher-local prompt and selections; never binds the full page's durable draft or handoff. */
export class PaletteSessionDraft implements ReactiveController {
  private draft: NewSessionDraftController | undefined;
  private data: NewSessionRouteData | undefined;
  private presentationScope: ReturnType<typeof gatewayPresentationScope> | undefined;
  private agentPickerOpen = false;
  private readonly preferences: PaletteSessionPreferences;
  private readonly settings: PaletteSessionSettings;
  private rejectedOpen: (() => void) | undefined;
  private coldSubmitReadSignal: AbortSignal | undefined;
  private owner: { gateway: ApplicationContext["gateway"]; url: string; scope: string } | undefined;
  private readonly connectMachine: ConnectMachineSetupState;
  private readonly subscriptions: SubscriptionsController;
  private static nextId = 0;
  private readonly idPrefix = `palette-session-${++PaletteSessionDraft.nextId}`;

  constructor(
    private readonly host: OpenClawLightDomElement,
    private readonly read: () => { context: ApplicationContext | undefined; open: boolean },
    private readonly callbacks: {
      onClose: () => void;
      onMessageChange?: (message: string) => void;
    },
  ) {
    this.preferences = new PaletteSessionPreferences(
      () => ({ draft: this.draft, context: this.read().context }),
      (preference) => this.restoreSettings(preference),
      () => host.requestUpdate(),
    );
    this.settings = new PaletteSessionSettings(host, this.idPrefix);
    this.connectMachine = new ConnectMachineSetupState(
      () => ({
        client: this.draft?.gateway.client ?? null,
        connected: this.draft?.gateway.connected ?? false,
      }),
      () => host.requestUpdate(),
    );
    this.subscriptions = new SubscriptionsController(host)
      .watch(
        () => this.draft && this.read().context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.draft && this.read().context?.agentIdentity,
        (identity, notify) => identity.subscribe(notify),
      )
      .watch(
        () => this.draft && this.read().context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
      )
      .watch(
        () => this.draft && this.read().context?.config,
        (config, notify) => config.subscribe(() => notify()),
      );
    host.addController(this);
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
      Boolean(this.coldSubmitReadSignal || this.draft?.submission.pendingPlacement.sessionKey)
    );
  }
  get hasPrompt(): boolean {
    return Boolean(
      this.message.trim() || this.draft?.submission.attachmentDraft.attachments.length,
    );
  }
  get canSubmit(): boolean {
    return (
      !this.coldSubmitReadSignal && this.hasPrompt && Boolean(this.draft?.submission.canSubmit())
    );
  }
  get error(): string | null {
    const submission = this.draft?.submission;
    return (
      submission?.error ??
      submission?.blockedSubmitNotice() ??
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
      this.rejectedOpen = undefined;
      this.draft.submission.clearError();
    }
    this.draft.submission.setMessage(value, mentions);
  }

  private attachmentProps(): ChatAttachmentControlsProps | undefined {
    const attachmentDraft = this.draft?.submission.attachmentDraft;
    if (!attachmentDraft) {
      return undefined;
    }
    const readSignal = attachmentDraft.readSignal;
    return {
      attachments: attachmentDraft.attachments,
      attachmentReads: attachmentDraft.reads,
      attachmentLimits: this.read().context?.gateway.snapshot.hello?.policy?.attachments,
      disabled: this.messageLocked,
      getAttachments: () => attachmentDraft.attachments,
      readSignal,
      onPendingReadsChange: (delta) => attachmentDraft.updatePending(readSignal, delta),
      onAttachmentsChange: (attachments) => {
        if (
          readSignal.aborted ||
          !this.read().open ||
          this.submitting ||
          this.draft?.submission.pendingPlacement.sessionKey
        ) {
          return;
        }
        this.rejectedOpen = undefined;
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

  adoptImageFiles(files: readonly File[], submitRequested = false) {
    const props = this.attachmentProps();
    if (!this.read().open || this.messageLocked || !props) {
      return;
    }
    const admitted = appendChatAttachmentFiles(files, props);
    if (submitRequested && admitted === files.length) {
      // The loader accepted Send before the readers existed. Carry that one
      // intent across preparation, but never across dismissal or invalidation.
      this.coldSubmitReadSignal = props.readSignal;
      this.host.requestUpdate();
    }
  }

  renderAttachments() {
    const props = this.attachmentProps();
    const preview = props ? renderAttachmentPreview(props) : nothing;
    return preview === nothing
      ? nothing
      : html`<div class="cmd-palette__attachments">${preview}</div>`;
  }

  open() {
    this.synchronizePresentationScope();
    // Reopening cannot abandon a request or turn an uncertain create into a second one.
    if (
      this.draft &&
      (this.submitting ||
        this.draft.submission.pendingPlacement.sessionKey ||
        this.draft.submission.submissionOutcomeUnknown ||
        this.draft.submission.error)
    ) {
      return;
    }
    const context = this.read().context;
    const agentId = context?.agentSelection.state.selectedId ?? "";
    this.data = {
      agentId,
      requestedAgentId: agentId,
      catalogId: "",
      model: "",
      catalogLabel: "",
      startTerminal: false,
    };
    if (!this.draft) {
      this.draft = new NewSessionDraftController(
        this.host,
        () => ({
          context: this.read().context,
          data: this.data,
          // A closed launcher still owns its submitted transaction until acceptance or failure.
          isConnected: this.host.isConnected,
        }),
        {
          requestUpdate: () => this.host.requestUpdate(),
          onMessageChange: (message) => this.callbacks.onMessageChange?.(message),
          querySelector: (selector) => this.host.querySelector(selector),
          activeElement: () => this.host.ownerDocument.activeElement,
          body: () => this.host.ownerDocument.body,
          pickerIdPrefix: this.idPrefix,
          preferenceScope: "palette",
          readPalettePreference: () => this.preferences.selection,
          closeTransientUi: () => closeSessionMenus(this.host),
          onInvalidate: () => this.connectMachine.close(),
          onRecoveryReady: (url, scope) => this.bindOwner(url, scope),
          onAccepted: (result) => this.accepted(result),
          retainRejectedPrompt: true,
        },
      );
    }
    this.rejectedOpen = undefined;
    this.coldSubmitReadSignal = undefined;
    this.draft.place.resetDraft();
    this.draft.submission.resetDraft();
    this.draft.place.setAgentsHydrated(this.draft.agentsReady());
    this.preferences.begin();
    this.draft.place.adoptAgentDefaults();
    this.host.requestUpdate();
  }

  close() {
    this.coldSubmitReadSignal = undefined;
    const submission = this.draft?.submission;
    // A failed create or rejected turn retains the same retry/recovery draft.
    // Ordinary dismissal discards its previews immediately, not on next open.
    if (
      submission &&
      !this.submitting &&
      !submission.pendingPlacement.sessionKey &&
      !submission.submissionOutcomeUnknown &&
      !submission.error
    ) {
      submission.attachmentDraft.reset({ release: true });
    } else {
      submission?.attachmentDraft.abortReads();
    }
    this.settings.close();
    this.draft?.browser.close();
    this.connectMachine.close();
    closeSessionMenus(this.host);
  }

  async submit(): Promise<void> {
    this.synchronizePresentationScope();
    if (!this.read().open || this.coldSubmitReadSignal || !this.hasPrompt || !this.draft) {
      return;
    }
    await this.draft.submission.submit(undefined, true);
  }

  hostUpdate() {
    this.synchronizePresentationScope();
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
    this.rejectedOpen = undefined;
    this.owner = undefined;
    this.draft?.gateway.invalidateDiscovery(true, "gateway-changed");
    this.draft?.submission.releasePendingPlacementOwner();
    this.draft?.submission.resetDraft();
    this.draft?.submission.restoreMessage("");
    this.callbacks.onMessageChange?.("");
  }

  hostUpdated() {
    const draft = this.draft;
    if (!draft) {
      return;
    }
    if (this.connectMachine.open && !draft.place.isAdmin()) {
      this.connectMachine.close();
    }
    this.preferences.synchronize();
    draft.synchronizeSelections();
    draft.submission.resumeInterruptedSubmission();
    const attachmentDraft = draft.submission.attachmentDraft;
    if (
      this.coldSubmitReadSignal &&
      (this.coldSubmitReadSignal.aborted || attachmentDraft.pendingReads === 0)
    ) {
      const ready =
        !this.coldSubmitReadSignal.aborted &&
        !attachmentDraft.reads
          .project(attachmentDraft.attachments)
          .some((entry) => entry.state === "error");
      this.coldSubmitReadSignal = undefined;
      this.host.requestUpdate();
      if (ready) {
        void this.submit();
      }
    }
    if (this.read().open) {
      void this.read().context?.agentIdentity.ensure(
        this.agentPickerOpen
          ? draft.place.agents().map((agent) => agent.id)
          : [draft.place.agentId],
      );
    }
  }

  hostDisconnected() {
    this.disconnect();
  }

  disconnect() {
    this.close();
    this.subscriptions.clear();
    this.draft?.disconnect();
  }

  renderControls() {
    const draft = this.draft;
    if (!draft) {
      return nothing;
    }
    return this.settings.render({
      draft,
      context: this.read().context,
      preferences: this.preferences,
      onAgentPickerOpen: (open) => {
        this.agentPickerOpen = open;
        this.host.requestUpdate();
      },
      onChange: () => this.preferences.changed(),
      onConnectMachine: () => {
        if (draft.place.isAdmin()) {
          this.settings.close();
          draft.browser.close();
          this.connectMachine.start();
        }
      },
    });
  }

  private restoreSettings(preference: PaletteSessionPreference | null) {
    if (!this.draft || !this.data || this.messageLocked) {
      return;
    }
    const defaultAgent = this.read().context?.agentSelection.state.selectedId ?? "";
    const agentId = preference?.agentId ?? defaultAgent;
    this.data = { ...this.data, agentId, requestedAgentId: agentId };
    this.draft.place.resetDraft();
    this.draft.place.setAgentsHydrated(this.draft.agentsReady());
    this.draft.place.adoptAgentDefaults();
    this.draft.place.restorePreferenceSelections();
  }

  renderRecovery() {
    return this.rejectedOpen
      ? html`<button class="btn btn--sm" type="button" @click=${this.rejectedOpen}>
          ${t("sessionsView.openSession")}
        </button>`
      : nothing;
  }

  renderAuxiliary() {
    return renderConnectMachineDialog({
      open: this.connectMachine.open && this.read().open && (this.draft?.place.isAdmin() ?? false),
      loading: this.connectMachine.loading,
      error: this.connectMachine.error,
      setup: this.connectMachine.setup,
      onRefresh: () => void this.connectMachine.refresh(),
      onClose: () => {
        this.connectMachine.close();
        this.host.requestUpdate();
      },
      onManageDevices: () => {
        this.callbacks.onClose();
        this.read().context?.navigate("devices");
      },
    });
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
      this.rejectedOpen = undefined;
      this.draft?.submission.restoreMessage("");
    }
    this.owner = { gateway, url, scope };
  }

  private accepted(result: SessionCreateOutcome & { agentId: string }) {
    const context = this.read().context;
    if (!context) {
      return;
    }
    const { gateway } = context;
    const client = gateway.snapshot.client;
    const revision = gateway.connectionRevision;
    const gatewayUrl = gateway.connection.gatewayUrl;
    const recoveryScope = gateway.snapshot.hello?.auth?.recoveryScope;
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
      if (
        this.read().context !== context ||
        context.gateway !== gateway ||
        gateway.snapshot.phase !== "connected" ||
        gateway.connection.gatewayUrl !== gatewayUrl ||
        gateway.connectionRevision !== revision ||
        gateway.snapshot.hello?.auth?.recoveryScope !== recoveryScope ||
        // A transport reconnect does not retire a session owned by the same
        // authenticated recovery scope. Unscoped actions stay connection-bound.
        (!recoveryScope && gateway.snapshot.client !== client)
      ) {
        return;
      }
      selectApplicationSession({
        selection: context.agentSelection,
        gateway,
        sessionKey: result.key,
        agentId: result.agentId,
      });
      context.navigate(
        "chat",
        sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: result.key,
          agentId: result.agentId,
        }).options,
      );
      if (result.initialRun.status === "rejected") {
        this.callbacks.onClose();
      }
    };
    showToast({
      fifo: true,
      message: `${resolveSessionDisplayName(result.key, row)}: ${status}`,
      actionLabel: t("sessionsView.openSession"),
      onAction: openSession,
    });
    if (result.initialRun.status === "rejected") {
      this.rejectedOpen = openSession;
      this.host.requestUpdate();
    } else {
      this.callbacks.onClose();
    }
  }
}
