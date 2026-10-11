import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { ImageLightbox } from "../../components/image-lightbox.tsx";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { renderSessionBackground } from "../../components/session-background-view.ts";
import "../../components/web-awesome-popover.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { LitContent, solidContent } from "../../lit/solid-content.tsx";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-surface.css";
import "../../styles/new-session.css";
import "../../styles/new-session-attachment-panel.css";
import { chatStartupStatusLabel } from "../chat/chat-run-startup.ts";
import { renderChatPermissionPicker } from "../chat/components/chat-permission-picker.ts";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import { CatalogBar } from "./catalog-target-view.tsx";
import * as catalog from "./catalog-target.ts";
import { NewSessionDictationStatus, NewSessionDictationView } from "./composer-dictation-view.tsx";
import { NewSessionComposer } from "./composer.tsx";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";
import { isWorktreeNameValid } from "./create-params.ts";
import { CreationComposer } from "./creation-composer-render.tsx";
import { DraftError, NewSessionBody } from "./draft-body.solid.tsx";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import {
  NewSessionIncognitoControl,
  NewSessionIncognitoNotice,
} from "./incognito-control-view.tsx";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionPageOwner, type PageHost } from "./new-session-page-owner.ts";
import { AgentSelect, NewSessionPlaceControls } from "./target-controls-view.tsx";

registerNewSessionSetupEnglish();

const pageOwners = new WeakMap<PageHost, NewSessionPageOwner>();

function DraftBlock(props: { page: () => NewSessionPageOwner; revision: () => object }) {
  const submission = () => props.page().submission;
  const place = () => props.page().place;
  const options = () => props.page().composerOptions();
  const permissionControl = (
    <Show when={!catalog.isTarget(props.page().data)}>
      <LitContent
        value={renderChatPermissionPicker({
          canSelectFull: place().isAdmin(),
          defaultMode: place().selectedAgent()?.defaultPermissionMode,
          disabled: submission().submitting || Boolean(submission().pendingPlacement.sessionKey),
          disabledReason: submission().submitting ? t("newSession.starting") : undefined,
          mode: submission().permissionMode,
          onSelect: (mode) => submission().setPermissionMode(mode ?? undefined),
        })}
      />
    </Show>
  );
  const dictationStatus = (
    <NewSessionDictationStatus control={props.page().dictation} renderRevision={props.revision()} />
  );
  const voiceControl = (
    <NewSessionDictationView
      control={props.page().dictation}
      ownerKey={props.page().routeOwnerKey()}
      inputDeviceId={props.page().context?.theme.settings.realtimeTalkInputDeviceId}
      renderRevision={props.revision()}
    />
  );
  return (
    <div
      class="new-session-page__draft"
      aria-busy={submission().submitting ? "true" : "false"}
      onCompositionStart={() => props.page().titlePreparation.setComposing(true)}
      onCompositionEnd={() => props.page().titlePreparation.setComposing(false)}
      onFocusOut={() => props.page().titlePreparation.setComposing(false)}
    >
      <CatalogBar
        data={props.page().data}
        groupPending={catalog.isGroupRoutePending(
          props.page().data,
          props.page().context?.sessions,
        )}
        retrying={
          props.page().gateway.catalogRetrying ||
          Boolean(
            props.page().data?.group && props.page().context?.sessions.groupsStatus() === "loading",
          )
        }
        onRetry={() => props.page().gateway.handleCatalogRetry()}
        agentSelect={
          <Show when={place().agents().length > 1}>
            <AgentSelect
              params={{
                agents: place().agents(),
                agentId: place().agentId,
                agentIdentity: props.page().context?.agentIdentity,
                disabled:
                  submission().submitting || Boolean(submission().pendingPlacement.sessionKey),
                onSelect: (agentId) => place().selectAgentId(agentId),
                onOpenChange: (open) => {
                  props.page().agentPickerOpen = open;
                },
              }}
            />
          </Show>
        }
        placeSelect={
          <NewSessionPlaceControls
            params={{
              context: props.page().context,
              data: props.page().data,
              gateway: props.page().gateway,
              place: place(),
              submitting: submission().submitting,
              pendingPlacement: Boolean(submission().pendingPlacement.sessionKey),
              onConnectMachine: () => props.page().openConnectMachine(),
              onNavigate: (route, routeOptions) =>
                props.page().context?.navigate(route, routeOptions),
              onFocusComposer: () =>
                submission().composerTextarea.getTextarea()?.focus({ preventScroll: true }),
              requestUpdate: () => props.page().requestUpdate(),
            }}
          />
        }
      />
      <Show when={place().worktree && !isWorktreeNameValid(place().worktreeName)}>
        <DraftError message={t("newSession.worktreeNameInvalid")} />
      </Show>
      <Show when={catalog.isTarget(props.page().data) && submission().capabilities.toolOverrides}>
        <DraftError
          message={t("newSession.terminalCapabilityOverridesUnsupported")}
          action={{
            label: t("common.reset"),
            onClick: () => submission().capabilities.setToolOverrides(null),
          }}
        />
      </Show>
      <Show when={submission().submissionOutcomeUnknown}>
        <DraftError
          message={t(
            submission().submissionOutcomeUnknown === "gateway-changed"
              ? "newSession.createOutcomeUnknown"
              : "newSession.placementSetupInterrupted",
          )}
          action={
            submission().pendingPlacement.sessionKey
              ? {
                  label: t("common.reset"),
                  onClick: () => submission().clearPendingPlacementRecovery(),
                }
              : undefined
          }
        />
      </Show>
      <NewSessionComposer
        options={Object.assign(options(), { permissionControl, dictationStatus, voiceControl })}
      />
      <Show when={!catalog.isTarget(props.page().data)}>
        <NewSessionIncognitoNotice active={submission().visibility === "incognito"} />
      </Show>
    </div>
  );
}

function PageContent(_props: { data: NewSessionRouteData | undefined }, host: PageHost) {
  const owner = pageOwners.get(host) ?? new NewSessionPageOwner(host);
  pageOwners.set(host, owner);
  owner.context = useOptionalApplication();
  const [revision, setRevision] = createSignal({}, { ownedWrite: true });
  const unsubscribe = owner.subscribe(() => setRevision({}));
  const page = () => {
    revision();
    return owner;
  };
  createEffect(revision, () =>
    untrack(() => {
      owner.updated();
      owner.titlePreparation.hostUpdated();
    }),
  );
  owner.connect();
  owner.requestUpdate();
  onCleanup(unsubscribe);
  const visibilityControl = {
    get visibility() {
      return page().submission.visibility;
    },
    get submitting() {
      return page().submission.submitting;
    },
    get pendingPlacement() {
      return page().submission.pendingPlacement;
    },
    incognitoDisabledReason: () => page().submission.incognitoDisabledReason(),
    setVisibility: (visibility: Parameters<DraftSubmissionFlow["setVisibility"]>[0]) =>
      owner.submission.setVisibility(visibility),
  };
  const completed = () => page().submission.completedSubmission;
  const userId = () => {
    const identity = page().context?.gateway.snapshot.selfUser?.identity;
    return identity?.type === "profile" ? identity.id : null;
  };
  const completion = () => {
    const current = completed();
    if (!current) {
      return undefined;
    }
    const startup = page().context?.placementStartup.get(current.key);
    return {
      label:
        current.error ??
        startup?.error ??
        chatStartupStatusLabel(null, startup) ??
        t("newSession.created"),
      onOpen: () => void owner.submission.openSubmittedSession(),
      disabled: page().context?.gateway.snapshot.phase !== "connected",
    };
  };
  const panel = () => page().attachmentPanel;
  const lightbox = () => page().imageLightbox;
  const panelContent = () => {
    const attachment = panel();
    return attachment ? { ...attachment.content } : null;
  };
  return (
    <>
      <div
        class={`new-session-page ${page().submission.pendingMessage ? "chat" : ""} ${page().submission.visibility === "incognito" ? "new-session-page--incognito" : ""}`}
      >
        <LitContent value={renderSessionBackground(page().context, "new-session")} />
        <Show when={!catalog.isTarget(page().data)}>
          <NewSessionIncognitoControl
            submission={visibilityControl}
            draftAvailable={page().submission.capabilities.canStartAsDraft(page().context)}
          />
        </Show>
        <NewSessionBody
          error={page().submission.error}
          pendingMessage={page().submission.pendingMessage}
          userId={userId()}
          submitting={page().submission.submitting}
          statusLabel={
            page().context?.gateway.snapshot.phase === "connected"
              ? undefined
              : t("connection.reconnecting")
          }
          completion={completion()}
          showDraft={Boolean(completed())}
          renderDraft={() => (
            <Show
              when={Boolean(completed())}
              fallback={
                <LitContent
                  value={renderWelcomeState({
                    ...page().welcomeOptions(),
                    composer: solidContent(DraftBlock, { page, revision }),
                  })}
                />
              }
            >
              <DraftBlock page={page} revision={revision} />
            </Show>
          )}
          onOpenImage={owner.setImageLightbox}
        />
        <CreationComposer
          composer={page().submission.creationComposer}
          onOpenImage={owner.setImageLightbox}
          renderRevision={revision()}
        />
        <ConnectMachineDialog
          {...page().connectMachine.view(page().place.isAdmin(), () => {
            owner.connectMachine.close();
            owner.context?.navigate("devices");
          })}
        />
        <Show when={lightbox()}>
          {(item) => (
            <ImageLightbox
              mediaKind={item().kind ?? "image"}
              gallery={item().gallery}
              connectVideo={item().connectVideo}
              loadFullResolution={item().loadFullResolution}
              src={item().src}
              originalSrc={item().originalSrc ?? ""}
              imageTitle={item().title}
              imageWidth={item().width}
              imageHeight={item().height}
              onImage-lightbox-close={() => owner.setImageLightbox(null)}
            />
          )}
        </Show>
      </div>
      <Show when={panel()}>
        <aside class="new-session-attachment-panel">
          <Show
            when={page().attachmentPanelLoader.visibleState?.status === "error"}
            fallback={
              <Show when={page().attachmentPanelLoader.visibleState}>
                <div role="status">{t("common.loading")}</div>
              </Show>
            }
          >
            <LitContent
              value={(() => {
                const state = page().attachmentPanelLoader.visibleState;
                return state?.status === "error"
                  ? renderLazyViewError({
                      error: state.error,
                      stale: state.stale,
                      onRetry: () => owner.attachmentPanelLoader.retry(),
                      onClose: owner.closeAttachmentPanel,
                    })
                  : undefined;
              })()}
            />
          </Show>
          <openclaw-chat-detail-panel
            prop:content={panelContent()}
            onChat-detail-panel-close={owner.closeAttachmentPanel}
          />
        </aside>
      </Show>
    </>
  );
}

export const NewSessionPage = defineSolidBridge<
  { data: NewSessionRouteData | undefined },
  {
    focusComposer(): void;
    requestUpdate(): void;
  }
>("openclaw-new-session-page", PageContent, {
  properties: { data: { default: undefined, attribute: false } },
  connected: (host) => pageOwners.get(host)?.connect(),
  disconnected: (host) =>
    queueMicrotask(() => {
      if (!host.isConnected) {
        pageOwners.get(host)?.disconnect();
      }
    }),
  propertyChanged: (host) => pageOwners.get(host)?.requestUpdate(),
  methods: {
    focusComposer: (host) => pageOwners.get(host)?.focusComposer(),
    requestUpdate: (host) => pageOwners.get(host)?.requestUpdate(),
  },
});

// These hosts remain custom elements so the detail panel keeps its lazy registration.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-detail-panel": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-detail-panel"]
      > & {
        "prop:content"?: SidebarContent | null;
      };
    }
  }
}
