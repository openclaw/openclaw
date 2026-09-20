import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { LazyCustomElementRequestController } from "../../app/lazy-custom-element.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import "../../styles/new-session-attachment-panel.css";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { normalizeAgentTargetLabel, resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { createIdleImport } from "../../lib/idle-import.ts";
import "../../components/web-awesome-popover.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { focusChatComposerFromPrintableKeydown } from "../chat/chat-pane-shared.ts";
import { chatStartupStatusLabel } from "../chat/chat-run-startup.ts";
import { renderChatImageLightbox } from "../chat/components/chat-image-lightbox.ts";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-surface.css";
import "../../styles/new-session.css";
import { installChatComposerPickerDismissal } from "../chat/components/chat-picker-overlay.ts";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import * as catalog from "./catalog-target.ts";
import { NewSessionDictationControl } from "./composer-dictation-control.ts";
import { ConnectMachineSetupState, renderConnectMachineDialog } from "./connect-machine-dialog.ts";
import { renderNewSessionBody } from "./draft-body.ts";
import { NewSessionDraftController } from "./draft-controller.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import * as drafts from "./draft-navigation-handoff.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { NewSessionTitleController } from "./draft-title.ts";
import { renderNewSessionDraftView } from "./draft-view.ts";
import { renderNewSessionIncognitoControl } from "./incognito-control.ts";
import { forgetInstantThreadPage } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import {
  closeAgentPicker,
  closeSessionMenus,
  createControllerHost,
} from "./new-session-runtime.ts";
import { renderAgentSelect, renderNewSessionPlaceControls } from "./target-controls.ts";

registerNewSessionSetupEnglish();

const { activateDraft, restoreDraft, restoreDraftOwner, retainDraft } = drafts;

const attachmentPanelElement = {
  tagName: "openclaw-chat-detail-panel",
  get label() {
    return t("chat.attachments.pastedText");
  },
  loadModule: async () => {
    await import("../../styles/chat/sidebar.css");
    await import("../chat/components/chat-detail-panel.ts");
  },
};

export class NewSessionPage extends OpenClawLightDomElement {
  @property({ attribute: false }) data: NewSessionRouteData | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  private retainedForHandoff: object | null = null;
  private openedFor: string | null = null;
  private readonly critterImport = createIdleImport(
    () => import("../../components/lobster-pet.runtime.ts"),
  );
  private openedGroupDefaults = "";
  private openedAgentId = "";
  private messageOwnerKey = "";
  private readonly connectMachine: ConnectMachineSetupState;
  @state() private attachmentPanel: {
    content: Extract<SidebarContent, { kind: "attachment" }>;
    ownerKey: string;
    agentId: string;
  } | null = null;
  private readonly attachmentPanelLoader = new LazyCustomElementRequestController(this);
  private readonly closeAttachmentPanel = () => {
    this.attachmentPanel = null;
  };
  private readonly openAttachmentPanel = (content: SidebarContent) => {
    if (content.kind === "attachment") {
      this.attachmentPanel = {
        content,
        ownerKey: this.routeOwnerKey(),
        agentId: this.place.agentId,
      };
    }
  };
  @state() private imageLightbox: ImageLightboxItem | null = null;
  @state() private agentPickerOpen = false;
  private readonly groupRouteRevalidation = new catalog.GroupRouteRevalidation(
    () => this.data,
    () => this.context?.revalidate("new-session"),
  );
  private readonly draft: NewSessionDraftController;
  private readonly gateway: DraftGatewayState;
  private readonly browser: DraftPlaceBrowser;
  private readonly place: DraftPlaceState;
  private readonly submission: DraftSubmissionFlow;
  private readonly dictation: NewSessionDictationControl;
  private readonly subscriptions: SubscriptionsController;
  private readonly titlePreparation = new NewSessionTitleController(this, () => ({
    context: this.context,
    data: this.data,
    place: this.place,
    submission: this.submission,
    dictating: this.dictation.active,
  }));
  private readonly flushDraft = () => this.submission.draftPersistence.persistNow();
  private readonly setImageLightbox = (item: ImageLightboxItem | null) => {
    this.imageLightbox = item;
  };

  constructor() {
    super();
    const host = createControllerHost(this);
    this.draft = new NewSessionDraftController(
      host,
      () => ({ context: this.context, data: this.data, isConnected: this.isConnected }),
      {
        requestUpdate: () => this.requestUpdate(),
        querySelector: (selector) => this.querySelector(selector),
        activeElement: () => this.ownerDocument.activeElement,
        body: () => this.ownerDocument.body,
        onInvalidate: () => {
          this.closeAttachmentPanel();
          this.connectMachine?.close();
        },
        onRecoveryReady: (gatewayUrl, recoveryScope) =>
          restoreDraftOwner(this.submission, gatewayUrl, recoveryScope),
        closeTransientUi: () => {
          this.closeAttachmentPanel();
          closeSessionMenus(this);
        },
        takePreparedTitle: () => this.titlePreparation.takePreparedTitle(),
        retainForHandoff: () => {
          if (!this.data || !this.isConnected) {
            return undefined;
          }
          const retention = {};
          this.retainedForHandoff = retention;
          return {
            page: this,
            data: this.data,
            synchronizeGateway: () => {
              if (this.context) {
                this.gateway.synchronize(this.context.gateway);
              }
            },
            release: () => {
              if (this.retainedForHandoff !== retention) {
                return;
              }
              this.retainedForHandoff = null;
              if (!this.isConnected) {
                this.disposeDraft();
              }
            },
          };
        },
      },
    );
    this.gateway = this.draft.gateway;
    this.browser = this.draft.browser;
    this.place = this.draft.place;
    this.submission = this.draft.submission;
    this.connectMachine = new ConnectMachineSetupState(
      () => ({ client: this.gateway.client, connected: this.gateway.connected }),
      () => this.requestUpdate(),
    );
    this.dictation = new NewSessionDictationControl({
      textarea: this.submission.composerTextarea,
      getClient: () => this.gateway.client,
      isConnected: () => this.gateway.connected,
      canCommit: () => !this.submission.submitting && !this.submission.pendingPlacement.sessionKey,
      onMessage: (message) => this.setMessageFromUser(message),
      onError: (message) => this.submission.setError(message),
      onSubmit: () => void this.submission.submit(),
      requestUpdate: () => this.requestUpdate(),
    });
    this.subscriptions = new SubscriptionsController(this)
      .effect(() => this.ownerDocument, installChatComposerPickerDismissal)
      .watch(
        () => this.context?.theme,
        (theme, notify) => theme.subscribe(notify),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.agentIdentity,
        (agentIdentity, notify) => agentIdentity.subscribe(notify),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        (sessions) => this.groupRouteRevalidation.synchronize(sessions),
      )
      .watch(
        () => this.context?.placementStartup,
        (startup, notify) => startup.subscribe(notify),
      )
      .watch(
        () => this.context?.runtimeConfig,
        (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      )
      .watch(
        () => this.context?.config,
        (config, notify) => config.subscribe(() => notify()),
      );
  }

  handleEvent(event: Event) {
    if (event instanceof KeyboardEvent) {
      focusChatComposerFromPrintableKeydown(this, event);
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.submission.draftPersistence.connect();
    this.critterImport.schedule();
    document.addEventListener("keydown", this, true);
    window.addEventListener("beforeunload", this.flushDraft);
  }

  override disconnectedCallback() {
    this.closeAttachmentPanel();
    this.attachmentPanelLoader.requestWhileActive(attachmentPanelElement, false);
    this.critterImport.dispose();
    document.removeEventListener("keydown", this, true);
    window.removeEventListener("beforeunload", this.flushDraft);
    this.subscriptions.clear();
    this.dictation.dispose();
    this.connectMachine.close();
    if (!this.retainedForHandoff) {
      this.disposeDraft();
    }
    super.disconnectedCallback();
  }

  private disposeDraft() {
    forgetInstantThreadPage(this.data, this);
    retainDraft(this.context, this.submission, this.openedFor, this.messageOwnerKey);
    this.draft.disconnect();
  }

  override willUpdate() {
    const panel = this.attachmentPanel;
    if (
      panel &&
      (panel.ownerKey !== this.routeOwnerKey() ||
        panel.agentId !== this.place.agentId ||
        this.submission.submitting ||
        Boolean(this.submission.pendingPlacement.sessionKey) ||
        !this.submission.attachmentDraft.attachments.some(
          (attachment) => attachment.id === panel.content.sourceIdentity,
        ))
    ) {
      this.attachmentPanel = null;
    }
    this.attachmentPanelLoader.requestWhileActive(
      attachmentPanelElement,
      this.attachmentPanel !== null,
    );
  }

  override updated() {
    if (this.connectMachine.open && !this.place.isAdmin()) {
      this.connectMachine.close();
    }
    this.gateway.retryPendingCatalogTarget();
    void this.context?.agentIdentity.ensure(
      this.agentPickerOpen ? this.place.agents().map((agent) => agent.id) : [this.place.agentId],
    );
    const agentsReady = this.draft.agentsReady();
    this.place.modelControl.loadCatalogTargets(
      this.context,
      agentsReady && this.place.agentId ? (this.place.selectedAgent()?.id ?? "") : "",
      this.context?.config.current.cliAgentsEnabled === true && !catalog.isTarget(this.data),
    );
    const openKey = this.routeOwnerKey();
    const resolvedAgentId = this.data?.agentId ?? "";
    const groupDefaults = catalog.groupDefaultsKey(this.data);
    if (this.openedFor !== openKey) {
      // Ordinary drafts release previews on reset and restore through durable storage.
      if (this.openedFor !== null && this.submission.visibility === "incognito") {
        retainDraft(this.context, this.submission, this.openedFor, this.messageOwnerKey);
      }
      const ownedMessage = this.messageOwnerKey === openKey ? this.submission.message : "";
      const ownedMentions = this.messageOwnerKey === openKey ? this.submission.mentions : undefined;
      this.openedFor = openKey;
      this.openedGroupDefaults = groupDefaults;
      this.openedAgentId = resolvedAgentId;
      this.place.setAgentsHydrated(agentsReady);
      this.resetDraft();
      this.messageOwnerKey = restoreDraft(
        this.context,
        this.submission,
        openKey,
        ownedMessage,
        ownedMentions,
      );
      return;
    }
    if (this.openedGroupDefaults !== groupDefaults) {
      this.openedGroupDefaults = groupDefaults;
      this.place.adoptGroupDefaults();
    }
    if (this.openedAgentId !== resolvedAgentId) {
      this.openedAgentId = resolvedAgentId;
      this.place.setAgentsHydrated(false);
    }
    this.draft.synchronizeSelections();
    activateDraft(this.submission, openKey);
    this.submission.resumeInterruptedSubmission();
  }

  private resetDraft() {
    this.place.resetDraft();
    this.submission.resetDraft();
    this.messageOwnerKey = catalog.routeKey(this.data);
    this.browser.clearPopoverHiding();
    closeAgentPicker(this);
    this.browser.close();
    this.connectMachine.close();
    this.place.adoptAgentDefaults();
  }

  private routeOwnerKey(): string {
    return this.data
      ? catalog.routeKey(this.data)
      : catalog.routeKeyFromSearch(window.location.search);
  }

  private setMessageFromUser(message: string, mentions?: readonly HumanMention[]) {
    if (!this.submission.submitting && !this.submission.pendingPlacement.sessionKey) {
      this.submission.setMessage(message, mentions);
      this.messageOwnerKey = catalog.routeKeyFromSearch(window.location.search);
    }
  }

  private renderTargetBar() {
    const agents = this.place.agents();
    const sessions = this.context?.sessions;
    return catalog.renderBar({
      data: this.data,
      groupPending: catalog.isGroupRoutePending(this.data, sessions),
      agentSelect:
        agents.length > 1
          ? renderAgentSelect({
              agents,
              agentId: this.place.agentId,
              agentIdentity: this.context?.agentIdentity,
              disabled:
                this.submission.submitting || Boolean(this.submission.pendingPlacement.sessionKey),
              onSelect: (agentId) => this.place.selectAgentId(agentId),
              onOpenChange: (open) => {
                this.agentPickerOpen = open;
              },
            })
          : nothing,
      placeSelect: renderNewSessionPlaceControls({
        context: this.context,
        data: this.data,
        gateway: this.gateway,
        place: this.place,
        submitting: this.submission.submitting,
        pendingPlacement: Boolean(this.submission.pendingPlacement.sessionKey),
        onConnectMachine: () => this.openConnectMachine(),
        onNavigate: (route, options) => this.context?.navigate(route, options),
        onFocusComposer: () =>
          this.submission.composerTextarea.getTextarea()?.focus({ preventScroll: true }),
        requestUpdate: () => this.requestUpdate(),
      }),
      retrying:
        this.gateway.catalogRetrying ||
        Boolean(this.data?.group && sessions?.groupsStatus() === "loading"),
      onRetry: this.gateway.handleCatalogRetry,
    });
  }

  private openConnectMachine() {
    if (!this.place.isAdmin()) {
      return;
    }
    this.browser.close();
    this.connectMachine.start();
  }

  private renderDraftBlock() {
    return renderNewSessionDraftView({
      context: this.context,
      gateway: this.gateway,
      place: this.place,
      submission: this.submission,
      dictation: this.dictation,
      titlePreparation: this.titlePreparation,
      draftOwnerKey: this.routeOwnerKey(),
      isCatalogTarget: catalog.isTarget(this.data),
      renderTargetBar: () => this.renderTargetBar(),
      requestUpdate: () => this.requestUpdate(),
      onMessage: (message, mentions) => this.setMessageFromUser(message, mentions),
      onOpenImage: this.setImageLightbox,
      onOpenSidebar: this.openAttachmentPanel,
    });
  }

  private renderWelcome() {
    const agent = this.place.selectedAgent();
    const identity = this.context?.agentIdentity.get(this.place.agentId);
    const gateway = this.context?.gateway.snapshot;
    return renderWelcomeState({
      currentAgentId: this.place.agentId,
      assistantName: agent ? normalizeAgentTargetLabel(agent, identity) : "",
      assistantAvatar: resolveAgentTextAvatar(agent ?? {}, identity),
      assistantAvatarUrl: resolveAgentAvatarUrl(agent ?? {}, identity),
      hint: t(catalog.isTarget(this.data) ? "newSession.nativeTerminalHint" : "newSession.hint"),
      composer: this.renderDraftBlock(),
      hideSecondaryContent: this.submission.visibility === "incognito",
      fadeSecondaryContent: this.submission.message.trim().length > 0,
      modelSetupRequired: this.submission.requiresModelSetup(),
      onModelSetup: () => this.context?.navigate("model-setup"),
      sessions: this.context?.sessions.state.result,
      sessionKey: buildAgentMainSessionKey({
        agentId: this.place.agentId || "main",
        mainKey: this.context?.agents.state.agentsList?.mainKey,
      }),
      sessionHost: {
        assistantAgentId: gateway?.assistantAgentId ?? null,
        agentsList: this.context?.agents.state.agentsList ?? null,
        hello: gateway?.hello ?? null,
      },
      onDraftChange: (next) => this.setMessageFromUser(next),
      onSend: () => void this.submission.submit(),
      onOpenSession: (sessionKey) => {
        const { context, submission } = this;
        if (!context || submission.submitting || submission.pendingPlacement.sessionKey) {
          return;
        }
        selectApplicationSession({
          selection: context.agentSelection,
          gateway: context.gateway,
          sessionKey,
          agentId: this.place.agentId,
        });
        context.navigate(
          "chat",
          sessionNavigationTarget({ context, face: "chat", sessionKey }).options,
        );
      },
    });
  }

  override render() {
    const pendingMessage = this.submission.pendingMessage;
    const completed = this.submission.completedSubmission;
    const startup = completed ? this.context?.placementStartup.get(completed.key) : null;
    const identity = this.context?.gateway.snapshot.selfUser?.identity;
    const incognito = this.submission.visibility === "incognito";
    const panelLoad = this.attachmentPanelLoader.visibleState;
    return html`
      <div
        class="new-session-page ${pendingMessage ? "chat" : ""} ${
          incognito ? "new-session-page--incognito" : ""
        }"
      >
        ${
          catalog.isTarget(this.data)
            ? nothing
            : renderNewSessionIncognitoControl(
                this.submission,
                this.submission.capabilities.canStartAsDraft(this.context),
              )
        }
        ${renderNewSessionBody({
          error: this.submission.error,
          pendingMessage,
          userId: identity?.type === "profile" ? identity.id : null,
          submitting: this.submission.submitting,
          statusLabel:
            this.context?.gateway.snapshot.phase === "connected"
              ? undefined
              : t("connection.reconnecting"),
          completion: completed
            ? {
                label:
                  completed.error ??
                  startup?.error ??
                  chatStartupStatusLabel(null, startup) ??
                  t("newSession.created"),
                onOpen: () => void this.submission.openSubmittedSession(),
                disabled: this.context?.gateway.snapshot.phase !== "connected",
              }
            : undefined,
          showDraft: Boolean(completed),
          renderDraft: () => (completed ? this.renderDraftBlock() : this.renderWelcome()),
          onOpenImage: this.setImageLightbox,
        })}
        ${renderConnectMachineDialog({
          open: this.connectMachine.open && this.place.isAdmin(),
          loading: this.connectMachine.loading,
          error: this.connectMachine.error,
          setup: this.connectMachine.setup,
          onRefresh: () => void this.connectMachine.refresh(),
          onClose: () => {
            this.connectMachine.close();
            this.requestUpdate();
          },
          onManageDevices: () => {
            this.connectMachine.close();
            this.context?.navigate("devices");
          },
        })}
        ${renderChatImageLightbox(this.imageLightbox, () => this.setImageLightbox(null))}
      </div>
      ${
        this.attachmentPanel
          ? html`<aside class="new-session-attachment-panel">
              ${
                panelLoad?.status === "error"
                  ? renderLazyViewError({
                      error: panelLoad.error,
                      stale: panelLoad.stale,
                      onRetry: () => this.attachmentPanelLoader.retry(),
                      onClose: this.closeAttachmentPanel,
                    })
                  : panelLoad
                    ? html`<div role="status">${t("common.loading")}</div>`
                    : nothing
              }
              <openclaw-chat-detail-panel
                .content=${{ ...this.attachmentPanel.content }}
                @chat-detail-panel-close=${this.closeAttachmentPanel}
              ></openclaw-chat-detail-panel>
            </aside>`
          : nothing
      }
    `;
  }
}
