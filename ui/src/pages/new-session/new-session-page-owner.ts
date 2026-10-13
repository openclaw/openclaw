import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { LazyCustomElementRequestController } from "../../app/lazy-custom-element.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentTargetLabel, resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { createIdleImport } from "../../lib/idle-import.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import type { SolidBridgeElement } from "../../lit/solid-bridge.ts";
import {
  ControllerHost,
  SubscriptionsController,
  viewState,
} from "../../lit/subscriptions-controller.ts";
import { focusChatComposerFromPrintableKeydown } from "../chat/chat-pane-shared.ts";
import { installChatComposerPickerDismissal } from "../chat/components/chat-picker-overlay.ts";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import type { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import * as catalog from "./catalog-target.ts";
import { NewSessionDictationControl } from "./composer-dictation-control.ts";
import type { NewSessionComposerOptions } from "./composer.tsx";
import { ConnectMachineSetupState } from "./connect-machine-dialog.ts";
import { NewSessionDraftController } from "./draft-controller.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import {
  activateDraft,
  restoreDraft,
  restoreDraftOwner,
  retainDraft,
} from "./draft-navigation-handoff.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { NewSessionTitleController } from "./draft-title.ts";
import { forgetInstantThreadPage } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import { closeAgentPicker, closeSessionMenus } from "./new-session-runtime.ts";

const attachmentPanelElement = {
  tagName: "openclaw-chat-detail-panel",
  get label() {
    return t("chat.attachments.pastedText");
  },
  loadModule: async () => {
    await import("../../styles/chat/sidebar.css");
    await import("../chat/components/chat-detail-panel.tsx");
  },
};

export type PageHost = SolidBridgeElement<
  { data: NewSessionRouteData | undefined },
  {
    focusComposer(): void;
    requestUpdate(): void;
  }
>;

export class NewSessionPageOwner extends ControllerHost {
  context?: ApplicationContext;
  get data() {
    return this.host.data;
  }
  get ownerDocument() {
    return this.host.ownerDocument;
  }
  querySelector(selector: string) {
    return this.host.querySelector(selector);
  }

  retainedForHandoff: object | null = null;
  openedFor: string | null = null;
  readonly critterImport = createIdleImport(
    () => import("../../components/lobster-pet.runtime.ts"),
  );
  openedGroupDefaults = "";
  openedAgentId = "";
  messageOwnerKey = "";
  readonly connectMachine: ConnectMachineSetupState;
  @viewState() attachmentPanel: {
    content: Extract<SidebarContent, { kind: "attachment" }>;
    ownerKey: string;
    agentId: string;
  } | null = null;
  readonly attachmentPanelLoader = new LazyCustomElementRequestController(this);
  readonly closeAttachmentPanel = () => {
    this.attachmentPanel = null;
  };
  readonly openAttachmentPanel = (content: SidebarContent) => {
    if (content.kind === "attachment") {
      this.attachmentPanel = {
        content,
        ownerKey: this.routeOwnerKey(),
        agentId: this.place.agentId,
      };
    }
  };
  @viewState() imageLightbox: ImageLightboxItem | null = null;
  @viewState() agentPickerOpen = false;
  readonly draft: NewSessionDraftController;
  readonly gateway: DraftGatewayState;
  readonly browser: DraftPlaceBrowser;
  readonly place: DraftPlaceState;
  readonly submission: DraftSubmissionFlow;
  readonly dictation: NewSessionDictationControl;
  readonly subscriptions: SubscriptionsController;
  readonly titlePreparation = new NewSessionTitleController(this, () => ({
    context: this.context,
    data: this.data,
    place: this.place,
    submission: this.submission,
    dictating: this.dictation.active,
  }));
  readonly flushDraft = () => this.submission.draftPersistence.persistNow();
  readonly setImageLightbox = (item: ImageLightboxItem | null) => {
    this.imageLightbox = item;
  };

  constructor(readonly host: PageHost) {
    super();
    this.addController({ hostUpdate: () => this.willUpdate() });
    this.draft = new NewSessionDraftController(
      this,
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
          closeSessionMenus(this.host);
        },
        takePreparedTitle: () => this.titlePreparation.takePreparedTitle(),
        retainForHandoff: () => {
          if (!this.data || !this.isConnected) {
            return undefined;
          }
          const retention = {};
          this.retainedForHandoff = retention;
          return {
            page: this.host,
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
      .watchStore(() => this.context?.theme)
      .watchStore(() => this.context?.agents)
      .watchStore(() => this.context?.agentIdentity)
      .watchStore(() => this.context?.sessions)
      .watchStore(() => this.context?.placementStartup)
      .watchStore(() => this.context?.runtimeConfig)
      .watch(
        () => this.context?.config,
        (config, notify) => config.subscribe(() => notify()),
      );
  }

  handleEvent(event: Event) {
    if (event instanceof KeyboardEvent) {
      focusChatComposerFromPrintableKeydown(this.host, event);
    }
  }

  focusComposer(): void {
    const context = this.context;
    const owner = this.routeOwnerKey();
    const previousFocus = document.activeElement;
    void this.updateComplete.then(() => {
      if (
        this.isConnected &&
        !this.retainedForHandoff &&
        this.context === context &&
        this.routeOwnerKey() === owner &&
        // A later interaction owns focus even if this draft is still mounted.
        (document.activeElement === previousFocus || document.activeElement === document.body) &&
        !document.openClawModalLayers?.size
      ) {
        this.submission.composerTextarea.getTextarea()?.focus({ preventScroll: true });
      }
    });
  }

  override connect() {
    if (this.isConnected) {
      return;
    }
    super.connect();
    this.submission.draftPersistence.connect();
    this.critterImport.schedule();
    document.addEventListener("keydown", this, true);
    window.addEventListener("beforeunload", this.flushDraft);
  }

  override disconnect() {
    if (!this.isConnected) {
      return;
    }
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
    super.disconnect();
  }

  disposeDraft() {
    forgetInstantThreadPage(this.data, this.host);
    retainDraft(this.context, this.submission, this.openedFor, this.messageOwnerKey);
    this.draft.disconnect();
  }

  willUpdate() {
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

  updated() {
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
      this.focusComposer();
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

  resetDraft() {
    this.place.resetDraft();
    this.submission.resetDraft();
    this.messageOwnerKey = catalog.routeKey(this.data);
    this.browser.clearPopoverHiding();
    closeAgentPicker(this.host);
    this.browser.close();
    this.connectMachine.close();
    this.place.adoptAgentDefaults();
  }

  routeOwnerKey(): string {
    return this.data
      ? catalog.routeKey(this.data)
      : catalog.routeKeyFromSearch(window.location.search);
  }

  setMessageFromUser(message: string, mentions?: readonly HumanMention[]) {
    if (!this.submission.submitting && !this.submission.pendingPlacement.sessionKey) {
      this.submission.setMessage(message, mentions);
      this.messageOwnerKey = catalog.routeKeyFromSearch(window.location.search);
    }
  }

  openConnectMachine() {
    if (!this.place.isAdmin()) {
      return;
    }
    this.browser.close();
    this.connectMachine.start();
  }

  composerOptions(): Omit<
    NewSessionComposerOptions,
    "dictationStatus" | "voiceControl" | "permissionControl"
  > {
    const { context, gateway, place, submission, dictation } = this;
    const draftOwnerKey = this.routeOwnerKey();
    const isCatalogTarget = catalog.isTarget(this.data);
    const capabilities = submission.capabilities;
    const preferences = context?.theme.settings;
    const dictationLocked = dictation.active;
    return {
      agent: place.selectedAgent(),
      agentId: place.agentId,
      attachmentDraft: submission.attachmentDraft,
      canSubmit: !submission.submitting && !dictationLocked && submission.canSubmit(),
      submitDisabledReason: submission.submitDisabledReason(),
      blockedSubmitNotice: submission.blockedSubmitNotice(),
      get dictationActive() {
        return dictation.active;
      },
      dictationPreview: dictation.previewDraft(),

      context,
      isCatalogTarget,
      draftOwnerKey,
      get message() {
        return submission.message;
      },
      mentions: submission.mentions,
      getMentions: () => submission.mentions,
      visibility: submission.visibility,
      draftAvailable: capabilities.canStartAsDraft(context),
      ...capabilities.composerProps(context, gateway, place.agentId),
      modelControl: place.modelControl,
      requiresModifier: preferences?.chatSendShortcut === "modifier-enter",
      requestUpdate: () => this.requestUpdate(),
      get submitting() {
        return submission.submitting;
      },
      textareaController: submission.composerTextarea,

      get messageLocked() {
        return Boolean(submission.pendingPlacement.sessionKey);
      },
      nativeTerminal: isCatalogTarget,
      onUnsupportedAttachment: () =>
        submission.setError(t("newSession.terminalAttachmentsUnsupported")),
      onInput: (message, mentions) => this.setMessageFromUser(message, mentions),
      onOpenImage: this.setImageLightbox,
      onOpenSidebar: this.openAttachmentPanel,
      onVisibilityChange: (visibility) => {
        if (!submission.submitting && !submission.pendingPlacement.sessionKey) {
          submission.setVisibility(visibility);
        }
      },
      onSubmit: () => void submission.submit(),
      onBackgroundSubmit:
        submission.visibility === "draft" || isCatalogTarget
          ? undefined
          : () => void submission.submit(undefined, true),
    };
  }

  welcomeOptions(): Omit<Parameters<typeof renderWelcomeState>[0], "composer"> {
    const agent = this.place.selectedAgent();
    const identity = this.context?.agentIdentity.get(this.place.agentId);
    const gateway = this.context?.gateway.snapshot;
    return {
      currentAgentId: this.place.agentId,
      assistantName: agent ? normalizeAgentTargetLabel(agent, identity) : "",
      assistantAvatar: resolveAgentTextAvatar(agent ?? {}, identity),
      assistantAvatarUrl: resolveAgentAvatarUrl(agent ?? {}, identity),
      hint: t(
        catalog.isTarget(this.data)
          ? "newSession.nativeTerminalHint"
          : this.place.requiredPlacement
            ? "newSession.requiredWorkerHint"
            : "newSession.hint",
      ),
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
    };
  }
}

// Rollback can reattach the same host after its Solid root has been disposed.
// Keep the synchronous draft owner with that host until the handoff releases it.
