import { createMemo, Errored, lazy, Loading, onCleanup, onSettled, Show } from "solid-js";
import type { SolidRouteProps } from "../../app-route-types.ts";
import { createGatewayControlUiReloadOptions } from "../../app/gateway-control-ui-reload.ts";
import { reloadAfterRenderErrorOnce } from "../../app/stale-chunk-reload.ts";
import { ImageLightbox } from "../../components/image-lightbox.tsx";
import { SessionBackgroundLayoutScope } from "../../components/session-background-layout-context.tsx";
import { SessionBackgroundView } from "../../components/session-background-view.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-surface.css";
import "../../styles/new-session.css";
import "../../styles/new-session-attachment-panel.css";
import { defineSolidBridge } from "../../lib/solid-bridge.ts";
import { focusChatComposerFromPrintableKeydown } from "../chat/chat-pane-shared.ts";
import { chatStartupStatusLabel } from "../chat/chat-run-startup.ts";
import { ChatPermissionPicker } from "../chat/components/chat-permission-picker.tsx";
import { installChatComposerPickerDismissal } from "../chat/components/chat-picker-overlay.ts";
import { ComposerDictationStatus } from "../chat/components/chat-voice-activity.tsx";
import { CatalogBar } from "./catalog-target-view.tsx";
import * as catalog from "./catalog-target.ts";
import { NewSessionDictationView } from "./composer-dictation-view.tsx";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";
import { NewSessionComposer } from "./composer.tsx";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";
import { isWorktreeNameValid } from "./create-params.ts";
import { DraftError, NewSessionBody } from "./draft-body.solid.tsx";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { createNewSessionTitle } from "./draft-title.ts";
import { DraftWelcome } from "./draft-welcome.tsx";
import {
  NewSessionIncognitoControl,
  NewSessionIncognitoNotice,
} from "./incognito-control-view.tsx";
import { restoredInstantThreadPage } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import { NewSessionPageOwner, type PageHost } from "./new-session-page-owner.ts";
import { AgentSelect, NewSessionPlaceControls } from "./target-controls-view.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

registerNewSessionSetupEnglish();

const CreationComposer = lazy(() => import("./creation-composer-render.tsx"), {
  export: "CreationComposer",
});

export function NewSessionRoute(props: SolidRouteProps<NewSessionRouteData>) {
  // Instant-thread handoff parks and restores this exact registered host across route roots.
  return (
    <Show
      when={restoredInstantThreadPage(props.data)}
      fallback={<openclaw-new-session-page prop:data={props.data} />}
      keyed
    >
      {(page) => page}
    </Show>
  );
}

const pageOwners = new WeakMap<PageHost, NewSessionPageOwner>();
// Retained draft hosts can reconnect under a fresh native bridge root.
const renderedPages = new WeakSet<PageHost>();

function DraftAgentSelect(props: {
  page: () => NewSessionPageOwner;
  ref?: (element: HTMLSpanElement) => void;
}) {
  const place = () => props.page().place;
  const submission = () => props.page().submission;
  return (
    <Show when={place().agents().length > 1}>
      <AgentSelect
        ref={(node) => {
          props.page().agentPicker = node;
          props.ref?.(node);
        }}
        params={{
          agents: place().agents(),
          agentId: place().agentId,
          agentIdentity: props.page().context?.agentIdentity,
          disabled: submission().submitting || Boolean(submission().pendingPlacement.sessionKey),
          onSelect: (agentId) => place().selectAgentId(agentId),
          onOpenChange: (open) => {
            props.page().agentPickerOpen = open;
            props.page().changed();
          },
        }}
      />
    </Show>
  );
}

function DraftBlock(props: {
  page: () => NewSessionPageOwner;
  revision: () => object;
  options: () => ReturnType<NewSessionPageOwner["composerOptions"]>;
}) {
  const submission = () => props.page().submission;
  const place = () => props.page().place;
  let root: HTMLDivElement | undefined;
  let agent: HTMLSpanElement | undefined;
  let notice: HTMLDivElement | undefined;
  let catalogElements: () => readonly HTMLElement[] = () => [];
  let placeElements: () => readonly HTMLElement[] = () => [];
  const surroundings = () =>
    root
      ? {
          root,
          obstacles: [
            agent,
            ...catalogElements(),
            ...placeElements(),
            ...(submission().visibility === "incognito" ? [notice] : []),
          ].filter((element): element is HTMLElement => element?.isConnected === true),
        }
      : undefined;
  const placeOptions = createMemo((): NewSessionPlaceControlsOptions => ({
    context: props.page().context,
    data: props.page().data,
    gateway: props.page().gateway,
    place: place(),
    submitting: submission().submitting,
    pendingPlacement: Boolean(submission().pendingPlacement.sessionKey),
    onConnectMachine: () => props.page().openConnectMachine(),
    onNavigate: (route, routeOptions) => props.page().context?.navigate(route, routeOptions),
    onFocusComposer: () =>
      submission().composerTextarea.getTextarea()?.focus({ preventScroll: true }),
    onChange: () => props.page().changed(),
  }));
  const permissionControl = (
    <Show when={!catalog.isTarget(props.page().data)}>
      <ChatPermissionPicker
        canSelectFull={place().isAdmin()}
        defaultMode={place().selectedAgent()?.defaultPermissionMode}
        disabled={submission().submitting || Boolean(submission().pendingPlacement.sessionKey)}
        disabledReason={submission().submitting ? t("newSession.starting") : undefined}
        mode={submission().permissionMode}
        onSelect={(mode) => submission().setPermissionMode(mode ?? undefined)}
      />
    </Show>
  );
  const dictationStatus = (
    <ComposerDictationStatus readDictation={() => props.page().dictation.dictation} />
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
      ref={(element) => {
        root = element;
      }}
      aria-busy={submission().submitting ? "true" : "false"}
      onCompositionStart={() => props.page().titlePreparation?.setComposing(true)}
      onCompositionEnd={() => props.page().titlePreparation?.setComposing(false)}
      onFocusOut={() => props.page().titlePreparation?.setComposing(false)}
    >
      <CatalogBar
        ref={(read) => {
          catalogElements = read;
        }}
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
          <Show when={Boolean(props.page().submission.completedSubmission)}>
            <DraftAgentSelect
              page={props.page}
              ref={(element) => {
                agent = element;
              }}
            />
          </Show>
        }
        placeSelect={
          <NewSessionPlaceControls
            params={placeOptions()}
            ref={(read) => {
              placeElements = read;
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
        surroundings={surroundings}
        options={Object.assign(props.options(), {
          permissionControl,
          dictationStatus,
          voiceControl,
        })}
      />
      <Show when={!catalog.isTarget(props.page().data)}>
        <NewSessionIncognitoNotice
          active={submission().visibility === "incognito"}
          ref={(element) => {
            notice = element;
          }}
        />
      </Show>
    </div>
  );
}

function PageContent(_props: { data: NewSessionRouteData | undefined }, host: PageHost) {
  const context = useOptionalApplication();
  // Native bridge roots do not inherit the router's error boundary.
  const Content = () => {
    const content = renderPageContent(host);
    onSettled(() => {
      renderedPages.add(host);
    });
    return content;
  };
  const RenderError = (props: { error: unknown; reset: () => void }) => {
    onSettled(() => {
      let active = true;
      if (context && !renderedPages.has(host)) {
        // Only failed initial mounts reload; later errors must preserve active drafts.
        void reloadAfterRenderErrorOnce(
          createGatewayControlUiReloadOptions(context.gateway, () => active && host.isConnected),
        );
      }
      return () => {
        active = false;
      };
    });
    return <LazyViewError error={props.error} onRetry={props.reset} />;
  };
  return (
    <SessionBackgroundLayoutScope>
      <Errored fallback={(error, reset) => <RenderError error={error()} reset={reset} />}>
        <Content />
      </Errored>
    </SessionBackgroundLayoutScope>
  );
}

function renderPageContent(host: PageHost) {
  const owner = pageOwners.get(host) ?? new NewSessionPageOwner(host);
  pageOwners.set(host, owner);
  owner.context = useOptionalApplication();
  const pageState = projectOwner(owner, (value) => value);
  const page = pageState.read;
  const revision = createMemo(() => ({ value: pageState.revision() }));
  owner.titlePreparation = createNewSessionTitle(() => ({
    context: owner.context,
    data: owner.data,
    place: owner.place,
    submission: owner.submission,
    dictating: owner.dictation.active,
  }));
  // Both draft presentations share one preparation per revision, not one per binding.
  const options = createMemo(() => page().composerOptions());
  const Draft = () => (
    <NewSessionComposerTextareaContext value={owner.submission.composerTextarea}>
      <DraftBlock page={page} revision={revision} options={options} />
    </NewSessionComposerTextareaContext>
  );
  // Bind gateway facts before publishing the first reconciled draft snapshot.
  owner.connect();
  onCleanup(() => owner.disconnect());
  onSettled(() => {
    const document = host.ownerDocument;
    const stops = [
      installChatComposerPickerDismissal(document),
      listen(
        document,
        "keydown",
        (event) =>
          focusChatComposerFromPrintableKeydown(
            host,
            event,
            owner.submission.composerTextarea.getTextarea(),
          ),
        true,
      ),
      listen(document.defaultView!, "beforeunload", owner.flushDraft),
    ];
    return () => stops.forEach((stop) => stop());
  });
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
  const creationComposer = createMemo(() => {
    const submission = page().submission;
    const composer = submission.creationComposer;
    // Rollback restores the initial composer; keep a second one only for retained input.
    return submission.pendingMessage || composer?.hasInput ? composer : undefined;
  });
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
  const panelError = () => {
    const state = page().attachmentPanelLoader.visibleState;
    return state?.status === "error" ? state : undefined;
  };
  const lightbox = () => page().imageLightbox;
  const panelContent = () => {
    const attachment = panel();
    return attachment ? { ...attachment.content } : null;
  };
  return (
    <>
      <div
        class={[
          "new-session-page",
          {
            chat: Boolean(page().submission.pendingMessage),
            "new-session-page--incognito": page().submission.visibility === "incognito",
          },
        ]}
      >
        <SessionBackgroundView context={page().context} surface="new-session" />
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
                <DraftWelcome
                  sessions={page().context?.sessions}
                  options={page().welcomeOptions()}
                  assistantNameControl={
                    !catalog.isTarget(page().data) && page().place.agents().length > 1 ? (
                      <DraftAgentSelect page={page} />
                    ) : undefined
                  }
                  composer={<Draft />}
                />
              }
            >
              <Draft />
            </Show>
          )}
          onOpenImage={owner.setImageLightbox}
        />
        <Show when={creationComposer()}>
          {(composer) => (
            <Errored
              fallback={(error, reset) => <LazyViewError error={error()} onRetry={reset} inline />}
            >
              <Loading fallback={<LoadingState />}>
                <CreationComposer composer={composer()} onOpenImage={owner.setImageLightbox} />
              </Loading>
            </Errored>
          )}
        </Show>
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
              loadDisplayImage={item().loadDisplayImage}
              readOriginalBlob={item().readOriginalBlob}
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
            when={panelError()}
            fallback={
              <Show when={page().attachmentPanelLoader.visibleState}>
                <div role="status">{t("common.loading")}</div>
              </Show>
            }
          >
            {(state) => (
              <LazyViewError
                error={state().error}
                stale={state().stale}
                onRetry={() => owner.attachmentPanelLoader.retry()}
                onClose={owner.closeAttachmentPanel}
              />
            )}
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

defineSolidBridge<
  { data: NewSessionRouteData | undefined },
  {
    focusComposer(): void;
  }
>("openclaw-new-session-page", PageContent, {
  properties: { data: { default: undefined, attribute: false } },
  propertyChanged: (host) => pageOwners.get(host)?.changed(),
  methods: {
    focusComposer: (host) => pageOwners.get(host)?.focusComposer(),
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-new-session-page": PageHost;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-new-session-page": HTMLAttributes<PageHost> & {
        "prop:data"?: NewSessionRouteData | undefined;
      };
    }
  }
}
