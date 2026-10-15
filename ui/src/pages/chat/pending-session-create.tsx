import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { emptyLegacyContent, LitContent } from "../../lit/solid-content.tsx";
import { CreationComposer } from "../new-session/creation-composer-render.tsx";
import { NewSessionBody } from "../new-session/draft-body.solid.tsx";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";
import { ChatComposer, resetChatComposerState } from "./components/chat-composer.tsx";
import { ChatImageLightbox } from "./components/chat-image-lightbox-view.tsx";
import { renderChatPaneHeader } from "./components/chat-pane-header.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

registerNewSessionSetupEnglish();

type PendingSessionCreateProps = {
  context: ApplicationContext | undefined;
  sessionKey: string;
  narrow: boolean;
  mergedChrome: boolean;
  navDrawerOpen: boolean;
};

/** Draft-owned input stays local; real pane controllers mount after acceptance. */
function PendingSessionCreateContent(props: PendingSessionCreateProps) {
  const composerId = `pending-create-${generateUUID()}`;
  const [revision, setRevision] = createSignal(0);
  let image: ImageLightboxItem | null = null;
  const notify = () => setRevision((value) => value + 1);
  const closeImage = () => {
    image?.release?.();
    image = null;
    notify();
  };
  const openImage = (item: ImageLightboxItem) => {
    closeImage();
    image = item;
    notify();
  };
  createEffect(
    () => ({ context: props.context, sessionKey: props.sessionKey }),
    ({ context }) => {
      if (!context) {
        return undefined;
      }
      const closeAndNotify = () => {
        closeImage();
      };
      const unsubscribe = [
        context.gateway.subscribe(closeAndNotify),
        context.chatSubmissions.subscribeCreate(closeAndNotify),
        context.placementStartup.subscribe(notify),
        context.theme.subscribe(notify),
      ];
      return () => {
        for (const release of unsubscribe) {
          release?.();
        }
      };
    },
  );
  const composerOwner = createMemo(() => {
    revision();
    return props.context?.chatSubmissions.readCreateComposer(props.sessionKey);
  });
  createEffect(composerOwner, (composer) => composer?.subscribe(notify));
  onCleanup(() => {
    image?.release?.();
    resetChatComposerState(composerId);
  });
  const view = createMemo(() => {
    revision();
    const context = props.context;
    if (!context) {
      return null;
    }
    const snapshot = context.gateway.snapshot;
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
      : context.chatSubmissions.readCreateMessage(props.sessionKey);
    const composer = context.chatSubmissions.readCreateComposer(props.sessionKey);
    const agentId = parseAgentSessionKey(props.sessionKey)?.agentId ?? "";
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
    // Reuse the chat chrome without mounting session controllers or granting
    // mutation access to an identity that the Gateway has not admitted yet.
    const noAction = () => {};
    return {
      submitting,
      header: renderChatPaneHeader({
        paneId: composerId,
        presented: false,
        narrow: props.narrow,
        mergedChrome: props.mergedChrome,
        navDrawerOpen: props.navDrawerOpen,
        title: context.chatSubmissions.readCreate()?.displayName ?? t("newSession.title"),
        titlePending: submitting && !context.chatSubmissions.readCreate()?.displayName,
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
        sessionMenuAction: emptyLegacyContent,
        onBeginRename: noAction,
        onRenameInput: noAction,
        onCommitRename: noAction,
        onCancelRename: noAction,
        onMenuOpenChange: noAction,
        onMenuAction: noAction,
        onOpenParentSession: noAction,
        onBranchSelect: noAction,
      }),
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
      creationComposer: composer?.canDisplay() ? composer : undefined,
      renderRevision: {},
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
    <ShellLayoutBoundary traits={{ workbench: true }}>
      <div class="sidebar-region">
        <div class="sidebar-region__header">
          <LitContent value={view()?.header} />
        </div>
        <section class="chat" data-region="main" aria-busy={view()?.submitting ? "true" : "false"}>
          <div class="chat-main__conversation-frame">
            <div class="chat-main__conversation">
              <Show when={view()?.body}>{(body) => <NewSessionBody {...body()} />}</Show>
              <div class="chat-footer">
                <Show when={view()}>
                  {(current) => (
                    <Show
                      when={current().creationComposer}
                      keyed
                      fallback={
                        <ChatComposer
                          {...current().composer}
                          renderRevision={current().renderRevision}
                        />
                      }
                    >
                      {(composer) => (
                        <CreationComposer
                          composer={composer}
                          onOpenImage={openImage}
                          renderRevision={current().renderRevision}
                        />
                      )}
                    </Show>
                  )}
                </Show>
              </div>
            </div>
          </div>
        </section>
      </div>
      <ChatImageLightbox
        item={(() => {
          revision();
          return image;
        })()}
        onClose={closeImage}
      />
    </ShellLayoutBoundary>
  );
}
export const PendingSessionCreate = defineSolidBridge<PendingSessionCreateProps>(
  "openclaw-pending-session-create",
  (props) => <PendingSessionCreateContent {...props} />,
  {
    properties: {
      context: { default: undefined, attribute: false },
      sessionKey: { default: "" },
      narrow: { default: false },
      mergedChrome: { default: false },
      navDrawerOpen: { default: false },
    },
  },
);
