import { createChangeListeners } from "../../../../src/shared/listeners.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { closeMenusWithin } from "../../components/solid/menu.tsx";
import { t } from "../../i18n/index.ts";
import { normalizeAgentTargetLabel, resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import type { ChatWelcomeProps } from "../chat/components/chat-welcome.tsx";
import { DirectDictationControl } from "../chat/composer-direct-dictation.ts";
import * as catalog from "./catalog-target.ts";
import type { NewSessionComposerOptions } from "./composer.tsx";
import { ConnectMachineSetupState } from "./connect-machine-dialog.ts";
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
import type { createNewSessionTitle } from "./draft-title.ts";
import { NewSessionDraft } from "./draft.ts";
import { forgetInstantThreadPage } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import type { SubmissionPresentation } from "./submission-action.ts";

export type PageHost = SolidBridgeElement<
  { data: NewSessionRouteData | undefined },
  {
    focusComposer(): void;
  }
>;

export class NewSessionPageOwner {
  private submissionLifetimeValue = Promise.withResolvers<void>();
  presentSubmit: SubmissionPresentation["presentSubmit"];
  get submissionLifetime() {
    return this.submissionLifetimeValue.promise;
  }
  readonly retireSubmissionPresentation = () => {
    this.submissionLifetimeValue.resolve();
    this.submissionLifetimeValue = Promise.withResolvers<void>();
    this.listeners.publish();
  };
  submit(background = false) {
    const operation = () => this.submission.submit(undefined, background);
    return this.presentSubmit ? this.presentSubmit(operation) : operation();
  }
  private readonly listeners = createChangeListeners();
  private contextSubscriptions: Array<() => void> = [];
  isConnected = false;
  private pendingChange = false;
  readonly changed = () => {
    if (!this.pendingChange && this.isConnected) {
      this.pendingChange = true;
      // Reconcile before Solid's queued render reads this mutable snapshot.
      queueMicrotask(() => {
        try {
          if (this.isConnected) {
            this.synchronize();
            this.titlePreparation?.synchronize();
          }
        } finally {
          this.pendingChange = false;
        }
      });
    }
    this.listeners.publish();
  };
  readonly subscribe = this.listeners.subscribe;
  context?: ApplicationContext;
  get data() {
    return this.host.data;
  }

  retainedForHandoff: object | null = null;
  openedFor: string | null = null;
  openedGroupDefaults = "";
  openedAgentId = "";
  messageOwnerKey = "";
  readonly connectMachine: ConnectMachineSetupState;
  attachmentPanel: {
    content: Extract<SidebarContent, { kind: "attachment" }>;
    ownerKey: string;
    agentId: string;
  } | null = null;
  readonly closeAttachmentPanel = () => {
    if (this.attachmentPanel) {
      this.attachmentPanel = null;
      this.changed();
    }
  };
  readonly openAttachmentPanel = (content: SidebarContent) => {
    if (content.kind === "attachment") {
      this.attachmentPanel = {
        content,
        ownerKey: this.routeOwnerKey(),
        agentId: this.place.agentId,
      };
      this.changed();
    }
  };
  imageLightbox: ImageLightboxItem | null = null;
  agentPickerOpen = false;
  agentPicker: HTMLSpanElement | undefined;
  readonly draft: NewSessionDraft;
  readonly gateway: DraftGatewayState;
  readonly browser: DraftPlaceBrowser;
  readonly place: DraftPlaceState;
  readonly submission: DraftSubmissionFlow;
  readonly dictation: DirectDictationControl;
  titlePreparation?: ReturnType<typeof createNewSessionTitle>;
  readonly flushDraft = () => this.submission.draftPersistence.persistNow();
  readonly setImageLightbox = (item: ImageLightboxItem | null) => {
    this.imageLightbox = item;
    this.changed();
  };

  constructor(readonly host: PageHost) {
    this.draft = new NewSessionDraft(
      () => ({ context: this.context, data: this.data, isConnected: this.isConnected }),
      {
        changed: this.changed,
        activeElement: () => this.host.ownerDocument.activeElement,
        onInvalidate: () => {
          this.retireSubmissionPresentation();
          this.closeAttachmentPanel();
          this.connectMachine?.close();
        },
        onRecoveryReady: (gatewayUrl, recoveryScope) =>
          restoreDraftOwner(this.submission, gatewayUrl, recoveryScope),
        closeTransientUi: () => {
          this.closeAttachmentPanel();
          this.draft.browser.close();
          closeMenusWithin(this.host);
        },
        takePreparedTitle: () => this.titlePreparation?.takePreparedTitle(),
        updateComplete: () => this.host.updateComplete,
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
      this.changed,
    );
    this.dictation = new DirectDictationControl({
      textarea: this.submission.composerTextarea,
      getClient: () => this.gateway.client,
      isConnected: () => this.gateway.connected,
      canCommit: () => !this.submission.submitting && !this.submission.pendingPlacement.sessionKey,
      onMessage: (message) => this.setMessageFromUser(message),
      onError: (message) => this.submission.setError(message),
      onSubmit: () => void this.submit(),
    });
    // Dictation receipts reconcile draft availability before the page projection reads it.
    this.dictation.subscribe(this.changed);
  }

  focusComposer(): void {
    const context = this.context;
    const owner = this.routeOwnerKey();
    const previousFocus = document.activeElement;
    void this.host.updateComplete.then(() => {
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

  connect() {
    if (this.isConnected) {
      return;
    }
    this.isConnected = true;
    // These receipts reconcile the draft and prepared title before the view reads them.
    const context = this.context;
    if (context) {
      this.contextSubscriptions = [
        context.theme,
        context.agents,
        context.agentIdentity,
        context.sessions,
        context.placementStartup,
        context.runtimeConfig,
        context.config,
      ].map((source) => source.subscribe(this.changed));
      let location = context.router.getState().location;
      this.contextSubscriptions.push(
        context.router.subscribe((state) => {
          if (state.location !== location) {
            location = state.location;
            this.retireSubmissionPresentation();
            this.browser.close();
          }
        }),
      );
    }
    this.draft.connect();
    this.submission.draftPersistence.connect();
    this.changed();
  }

  disconnect() {
    this.retireSubmissionPresentation();
    if (!this.isConnected) {
      return;
    }
    this.browser.close();
    for (const stop of this.contextSubscriptions.splice(0)) {
      stop();
    }
    this.closeAttachmentPanel();
    this.dictation.dispose();
    this.connectMachine.close();
    if (!this.retainedForHandoff) {
      this.disposeDraft();
    }
    this.isConnected = false;
  }

  disposeDraft() {
    forgetInstantThreadPage(this.data, this.host);
    retainDraft(this.context, this.submission, this.openedFor, this.messageOwnerKey);
    this.draft.disconnect();
  }

  synchronize() {
    this.draft.synchronize();
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
      this.closeAttachmentPanel();
    }

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
      this.place.agentsHydrated = agentsReady;
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
      this.place.agentsHydrated = false;
    }
    this.draft.synchronizeSelections();
    activateDraft(this.submission, openKey);
    this.submission.synchronizeSubmission();
  }

  resetDraft() {
    this.retireSubmissionPresentation();
    this.place.resetDraft();
    this.submission.resetDraft();
    this.messageOwnerKey = catalog.routeKey(this.data);
    if (this.agentPicker) {
      closeMenusWithin(this.agentPicker);
    }
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
      draftSource: submission.composerDraft,
      canSubmit: !submission.submitting && !dictationLocked && submission.canSubmit(),
      submitDisabledReason: submission.submitDisabledReason(),
      onBlockedSubmit: () => submission.noteBlockedSubmitAttempt(),
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
      onChange: this.changed,
      get submitting() {
        return submission.submitting;
      },

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
      onSubmit: () => void this.submit(),
      onBackgroundSubmit:
        submission.visibility === "draft" || isCatalogTarget
          ? undefined
          : () => void this.submit(true),
    };
  }

  welcomeOptions(): Omit<ChatWelcomeProps, "composer"> {
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
      onSend: () => void this.submit(),
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
