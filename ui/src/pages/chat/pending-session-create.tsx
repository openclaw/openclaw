import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { buildAgentOnboardingGreeting } from "../../../../src/shared/agent-onboarding.js";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import type { GatewayStatusProps } from "../../components/gateway-status.ts";
import { ImageLightboxItemView } from "../../components/image-lightbox.tsx";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge } from "../../lib/solid-bridge.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { CreationComposer } from "../new-session/creation-composer-render.tsx";
import { NewSessionBody } from "../new-session/draft-body.solid.tsx";
import { ChatAvatar } from "./chat-avatar-view.tsx";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { ChatComposer, resetChatComposerState } from "./components/chat-composer.tsx";
import { MessageMarkdown } from "./components/chat-message-text-view.tsx";
import { ChatPaneHeader, ChatPaneIncognitoNotice } from "./components/chat-pane-header.tsx";
import type { ChatPaneHeaderProps } from "./components/chat-pane-header.types.ts";
import { ChatPaneMobileHeader } from "./components/chat-pane-mobile-header.tsx";
import { ChatWorkingIndicator } from "./components/chat-working-indicator.tsx";
import { buildLocalUserMessage } from "./user-message-content.ts";

registerNewSessionSetupEnglish();

type PendingSessionCreateProps = {
  context: ApplicationContext | undefined;
  sessionKey: string;
  narrow: boolean;
  mergedChrome: boolean;
  navDrawerOpen: boolean;
  gatewayStatus?: GatewayStatusProps | null;
};

/** Draft-owned input stays local; real pane controllers mount after acceptance. */
function PendingSessionCreateContent(
  props: PendingSessionCreateProps,
  context: ApplicationContext,
) {
  const composerId = `pending-create-${generateUUID()}`;
  const startedAt = Date.now();
  const sources = [
    projectOwner(context.gateway, (owner) => owner.snapshot),
    projectOwner(context.placementStartup, (owner) => owner),
    projectOwner(context.theme, (owner) => owner),
    projectOwner(context.agents, (owner) => owner.state),
    projectOwner(context.sessions, (owner) => owner.state),
    projectSource(context.chatSubmissions, {
      read: (owner) => owner,
      subscribe: (owner, notify) => owner.subscribeCreate(notify),
      equality: "revision",
    }),
  ];
  const [imageRevision, setImageRevision] = createSignal(0);
  let image: ImageLightboxItem | null = null;
  const openImage = (item: ImageLightboxItem | null) => {
    image?.release?.();
    image = item;
    setImageRevision((value) => value + 1);
  };
  const closeImage = () => openImage(null);
  onSettled(() => {
    // These events revoke image custody synchronously, even between render commits.
    const stopGateway = context.gateway.subscribe(closeImage);
    const stopCreate = context.chatSubmissions.subscribeCreate(closeImage);
    return () => {
      stopGateway();
      stopCreate();
      image?.release?.();
      resetChatComposerState(composerId);
    };
  });
  const composerOwner = createMemo(() => {
    sources.forEach((source) => source.read());
    return context.chatSubmissions.readCreateComposer(props.sessionKey);
  });
  const composerProjection = createMemo(() => {
    const owner = composerOwner();
    return owner && projectOwner(owner, (source) => source);
  });
  const view = createMemo(() => {
    sources.forEach((source) => source.read());
    const snapshot = context.gateway.snapshot;
    const submissions = context.chatSubmissions;
    const identity = snapshot.selfUser?.identity;
    const startup = readDeletedSessionStartup(context, props.sessionKey);
    const pendingCreate = submissions.readCreateFor(props.sessionKey);
    const failure = pendingCreate?.failure;
    const failed = startup?.phase === "failed" || failure !== undefined;
    const cancelled = startup?.phase === "cancelled";
    const submitting = !failed && !cancelled;
    const turn = startup?.initialTurn;
    const errorAction = failure
      ? { label: t("newSession.tryAgain"), onClick: failure.retry }
      : failed && startup
        ? startup.discardAndReload
          ? {
              label: t("newSession.discardUnsavedAndReload"),
              onClick: startup.discardAndReload,
            }
          : startup.retryable
            ? {
                label: t("common.retry"),
                onClick: () => context.placementStartup.retry(startup.sessionKey),
              }
            : undefined
        : undefined;
    const pendingMessage = turn
      ? buildLocalUserMessage(
          {
            text: turn.text,
            mentions: turn.mentions,
            attachments: turn.attachments,
            createdAt: turn.createdAt,
          },
          "available",
        )
      : submissions.readCreateMessage(props.sessionKey);
    const creationComposer = composerProjection()?.read();
    const displayName = pendingCreate?.displayName;
    // A background start can be opened from the Gateway's row before it answers.
    const row = context.sessions.state.result?.sessions.find(
      (candidate) => candidate.key === props.sessionKey,
    );
    const agentId = parseAgentSessionKey(props.sessionKey)?.agentId ?? "";
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
    const creatingAgent =
      pendingCreate !== undefined && context.agents.state.pendingAgent?.id === agentId;
    // Foreground handoffs await a generated title; a background start is plainly "New session".
    const background = pendingCreate !== undefined && pendingCreate !== submissions.readCreate();
    const statusLabel =
      snapshot.phase !== "connected"
        ? t("connection.reconnecting")
        : creatingAgent
          ? t("agentChip.creatingAgent")
          : (chatStartupStatusLabel(null, startup) ?? t("newSession.starting"));
    // Reuse the chat chrome without mounting session controllers or granting
    // mutation access to an identity that the Gateway has not admitted yet.
    const noAction = () => {};
    return {
      submitting,
      header: {
        paneId: composerId,
        presented: false,
        narrow: props.narrow,
        mergedChrome: props.mergedChrome,
        gatewayStatus: props.gatewayStatus,
        title:
          displayName ??
          (row ? resolveSessionDisplayName(props.sessionKey, row) : t("newSession.title")),
        titlePending: submitting && !displayName && !row && !background,
        session: undefined,
        incognito: isIncognitoSessionKey(props.sessionKey),
        catalog: false,
        editing: false,
        renameValue: "",
        workspaceRoot: null,
        workspaceLabel: null,
        workspaceIcon: null,
        parentSession: null,
        branch: null,
        branches: [],
        branchSwitchDisabledReason: null,
        platform: null,
        canReveal: false,
        copiedAction: null,
        onBeginRename: noAction,
        onRenameInput: noAction,
        onCommitRename: noAction,
        onCancelRename: noAction,
        onMenuOpenChange: noAction,
        onMenuAction: noAction,
        onOpenParentSession: noAction,
        onBranchSelect: noAction,
      } satisfies ChatPaneHeaderProps,
      body: {
        inChat: true,
        error: failed ? (failure?.error ?? startup?.error ?? t("newSession.createFailed")) : null,
        errorAction: errorAction
          ? {
              ...errorAction,
              // Placement recovery needs its recovery scope; a background retry only a connection.
              disabled:
                snapshot.phase !== "connected" ||
                (!failure && !snapshot.client?.recoveryScopeReady),
            }
          : undefined,
        pendingMessage,
        userId: identity?.type === "profile" ? identity.id : null,
        submitting,
        statusLabel,
        completion: cancelled
          ? { label: startup.error ?? t("newSession.placementCancelled") }
          : failed
            ? {
                label: t("chat.queue.notSent"),
              }
            : undefined,
        renderDraft: () => (
          <div class="new-session-page__starting chat-thread-inner">
            <Show when={creatingAgent}>
              {/* The shared greeting is a presentation preview; only the Gateway persists it. */}
              <div class="chat-group assistant">
                <ChatAvatar
                  role="assistant"
                  assistant={{
                    agentId,
                    name: displayName ?? t("agentChip.newAgent"),
                    avatar: null,
                  }}
                />
                <div class="chat-group-messages">
                  <div class="chat-bubble chat-bubble--first">
                    <MessageMarkdown
                      markdown={buildAgentOnboardingGreeting(displayName)}
                      messageKey={`${composerId}-greeting`}
                      options={{ role: "assistant", isStreaming: false }}
                      markdownOptions={{ codeBlockChrome: "none" }}
                    />
                  </div>
                </div>
              </div>
            </Show>
            <div class="chat-group assistant chat-group--working">
              <div class="chat-group-messages">
                <ChatWorkingIndicator
                  part={{ kind: "reading-indicator", key: composerId, startedAt }}
                  options={{ startupLabel: statusLabel }}
                />
              </div>
            </div>
          </div>
        ),
        onOpenImage: openImage,
      },
      creationComposer: creationComposer?.canDisplay() ? creationComposer : undefined,
      composer: {
        paneId: composerId,
        sessionKey: props.sessionKey,
        currentAgentId: agentId,
        assistantName:
          displayName ?? agent?.identity?.name ?? agent?.name ?? t("agentChip.newAgent"),
        connected: snapshot.phase === "connected",
        canSend: false,
        sessionAdmitted: false,
        mobileComposer: props.mergedChrome,
        disabledReason: null,
        sending: submitting,
        messages: [],
        stream: null,
        queue: [],
        draft: "",
        modelCatalog: [],
        modelSwitching: false,
        sessions: null,
        onDraftChange: noAction,
        onSend: noAction,
        onQueueRemove: noAction,
      },
    };
  });
  const questions = createComposerQuestions(composerId, () => view().composer);
  return (
    <>
      <div class="sidebar-region">
        <div class="sidebar-region__header">
          {/* Phones show the admitted chat's own header from the first frame; its
              session controls stay disabled until the Gateway accepts the session. */}
          <Show when={props.mergedChrome} fallback={<ChatPaneHeader {...view().header} />}>
            <ChatPaneMobileHeader
              active
              title={view().header.title}
              titlePending={view().header.titlePending}
              incognito={view().header.incognito}
              navDrawerOpen={props.navDrawerOpen}
              panelsOpen={false}
              notice={
                props.gatewayStatus?.kind && props.gatewayStatus.kind !== "connected"
                  ? {
                      kind: "gateway",
                      status: props.gatewayStatus.kind,
                      onRetry: props.gatewayStatus.onRetry,
                    }
                  : undefined
              }
              actions={
                <button
                  type="button"
                  class="mobile-header__control"
                  disabled
                  aria-label={t("chat.sidebar.sessionMenu", { session: view().header.title })}
                >
                  <Icon name="moreHorizontal" />
                </button>
              }
            />
            <Show when={view().header.incognito}>
              <ChatPaneIncognitoNotice />
            </Show>
          </Show>
        </div>
        <section class="chat" data-region="main" aria-busy={view().submitting ? "true" : "false"}>
          <div class="chat-main__conversation-frame">
            <div class="chat-main__conversation">
              <NewSessionBody {...view().body} />
              <div class="chat-footer">
                <Show
                  when={view().creationComposer}
                  keyed
                  fallback={<ChatComposer {...view().composer} questions={questions} />}
                >
                  {(composer) => (
                    <CreationComposer
                      composer={composer}
                      mobileComposer={props.mergedChrome}
                      onOpenImage={openImage}
                    />
                  )}
                </Show>
              </div>
            </div>
          </div>
        </section>
      </div>
      <ImageLightboxItemView
        item={(() => {
          imageRevision();
          return image;
        })()}
        onClose={closeImage}
      />
    </>
  );
}
export const PendingSessionCreate = defineSolidBridge<PendingSessionCreateProps>(
  "openclaw-pending-session-create",
  (props) => (
    <Show when={props.context} keyed>
      {(context) => PendingSessionCreateContent(props, context)}
    </Show>
  ),
  {
    properties: {
      context: { default: undefined, attribute: false },
      sessionKey: { default: "" },
      narrow: { default: false },
      mergedChrome: { default: false },
      navDrawerOpen: { default: false },
      gatewayStatus: { default: null },
    },
  },
);
