import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import type { GatewayStatusProps } from "../../components/gateway-status.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge } from "../../lib/solid-bridge.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { CreationComposer } from "../new-session/creation-composer-render.tsx";
import { NewSessionBody } from "../new-session/draft-body.solid.tsx";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";
import { ChatComposer, resetChatComposerState } from "./components/chat-composer.tsx";
import { ChatImageLightbox } from "./components/chat-image-lightbox-view.tsx";
import { ChatPaneHeader, type ChatPaneHeaderProps } from "./components/chat-pane-header.tsx";
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
  const sources = [
    projectOwner(context.gateway, (owner) => owner.snapshot),
    projectOwner(context.placementStartup, (owner) => owner),
    projectOwner(context.theme, (owner) => owner),
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
    const failed = startup?.phase === "failed";
    const cancelled = startup?.phase === "cancelled";
    const checking = startup?.action === "check-delivery";
    const submitting = !failed && !cancelled;
    const turn = startup?.initialTurn;
    const errorAction =
      failed && startup
        ? startup.discardAndReload
          ? {
              label: t("newSession.discardUnsavedAndReload"),
              onClick: startup.discardAndReload,
            }
          : startup.retryable
            ? {
                label: t(checking ? "chat.queue.checkDelivery" : "common.retry"),
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
    const agentId = parseAgentSessionKey(props.sessionKey)?.agentId ?? "";
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
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
        navDrawerOpen: props.navDrawerOpen,
        gatewayStatus: props.gatewayStatus,
        title: submissions.readCreate()?.displayName ?? t("newSession.title"),
        titlePending: submitting && !submissions.readCreate()?.displayName,
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
        error: failed
          ? (startup.error ??
            t(checking ? "chat.queue.checkDeliveryHelp" : "newSession.createFailed"))
          : null,
        errorAction: errorAction
          ? {
              ...errorAction,
              disabled: snapshot.phase !== "connected" || !snapshot.client?.recoveryScopeReady,
            }
          : undefined,
        pendingMessage,
        userId: identity?.type === "profile" ? identity.id : null,
        submitting,
        statusLabel:
          snapshot.phase === "connected"
            ? chatStartupStatusLabel(null, startup)
            : t("connection.reconnecting"),
        completion: cancelled
          ? { label: startup.error ?? t("newSession.placementCancelled") }
          : failed
            ? {
                label: t(checking ? "chat.queue.deliveryUnconfirmed" : "chat.queue.notSent"),
              }
            : undefined,
        renderDraft: () => <div role="status">{t("connection.reconnecting")}</div>,
        onOpenImage: openImage,
      },
      creationComposer: creationComposer?.canDisplay() ? creationComposer : undefined,
      composer: {
        paneId: composerId,
        sessionKey: props.sessionKey,
        currentAgentId: agentId,
        assistantName: agent?.identity?.name ?? agent?.name ?? agentId,
        connected: snapshot.phase === "connected",
        canSend: false,
        sessionAdmitted: false,
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
  return (
    <>
      <div class="sidebar-region">
        <div class="sidebar-region__header">
          <ChatPaneHeader {...view().header} />
        </div>
        <section class="chat" data-region="main" aria-busy={view().submitting ? "true" : "false"}>
          <div class="chat-main__conversation-frame">
            <div class="chat-main__conversation">
              <NewSessionBody {...view().body} />
              <div class="chat-footer">
                <Show
                  when={view().creationComposer}
                  keyed
                  fallback={<ChatComposer {...view().composer} />}
                >
                  {(composer) => <CreationComposer composer={composer} onOpenImage={openImage} />}
                </Show>
              </div>
            </div>
          </div>
        </section>
      </div>
      <ChatImageLightbox
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
