import {
  children,
  createMemo,
  createSignal,
  Errored,
  isPending,
  lazy,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import { createGatewayControlUiReloadOptions } from "../../app/gateway-control-ui-reload.ts";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  reloadAfterRenderErrorOnce,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { ImageLightbox } from "../../components/image-lightbox.tsx";
import { SessionBackgroundLayoutScope } from "../../components/session-background-layout-context.tsx";
import { SessionBackgroundView } from "../../components/session-background-view.tsx";
import { Icon } from "../../components/solid/icon.tsx";
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
import { focusChatComposerFromKeydown } from "../chat/chat-pane-shared.ts";
import { chatStartupStatusLabel } from "../chat/chat-run-startup.ts";
import { ChatPermissionPicker } from "../chat/components/chat-permission-picker.tsx";
import { installChatComposerPickerDismissal } from "../chat/components/chat-picker-overlay.ts";
import { ComposerDictationStatus } from "../chat/components/chat-voice-activity.tsx";
import { DirectDictationView } from "../chat/components/direct-dictation-view.tsx";
import { CatalogBar } from "./catalog-target-view.tsx";
import * as catalog from "./catalog-target.ts";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";
import { NewSessionComposer } from "./composer.tsx";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";
import { isWorktreeNameValid } from "./create-params.ts";
import { DraftError, NewSessionBody, preloadNewSessionSubmission } from "./draft-body.solid.tsx";
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
import { createSubmissionAction } from "./submission-action.ts";
import { AgentSelect, NewSessionPlaceControls } from "./target-controls-view.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

registerNewSessionSetupEnglish();

const CreationComposer = lazy(() => import("./creation-composer-render.tsx"), {
  export: "CreationComposer",
});
const AttachmentDetailPanel = lazy(
  async () => {
    await import("../../styles/chat/sidebar.css");
    return import("../chat/components/chat-detail-panel.tsx");
  },
  { export: "ChatDetailPanel" },
);
const preloadSubmissionViews = () => {
  preloadNewSessionSubmission();
  void CreationComposer.preload().catch(() => undefined);
};

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
  submitting: boolean;
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
    <DirectDictationView
      control={props.page().dictation}
      ownerKey={props.page().routeOwnerKey()}
      inputDeviceId={props.page().context?.theme.settings.realtimeTalkInputDeviceId}
      idleLabel={t("newSession.dictate")}
      renderRevision={props.revision()}
    />
  );
  return (
    <div
      class="new-session-page__draft"
      ref={(element) => {
        root = element;
      }}
      aria-busy={props.submitting ? "true" : "false"}
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
        retryRead={props.page().gateway.catalogRetryRead}
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
      <Show when={submission().blockedSubmitNotice()}>
        <div
          class="new-session-page__blocked-submit agent-chat__composer-status"
          data-tone="info"
          role="status"
        >
          <div class="agent-chat__composer-status-band">
            <span class="agent-chat__composer-status-icon" aria-hidden="true">
              <Icon name="info" />
            </span>
            <span class="agent-chat__composer-status-text">
              {submission().blockedSubmitNotice()}
            </span>
          </div>
        </div>
      </Show>
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
  const Content = () => renderPageContent(host);
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
  const initialConnectionReady = () => page().isConnected;
  onSettled(() => {
    owner.connect();
    return () => owner.disconnect();
  });
  const revision = createMemo(() => ({ value: pageState.revision() }));
  const submissionError = createMemo(() => page().submission.error);
  const saving = createSubmissionAction(
    () => owner,
    pageState.revision,
    submissionError,
    (failure) =>
      owner.submission.setError(failure instanceof Error ? failure.message : String(failure)),
  );
  onSettled(() => {
    const preparation = createNewSessionTitle(() => ({
      context: owner.context,
      data: owner.data,
      place: owner.place,
      submission: owner.submission,
      dictating: owner.dictation.active,
    }));
    owner.titlePreparation = preparation;
    preparation.synchronize();
    return () => {
      preparation.dispose();
      if (owner.titlePreparation === preparation) {
        owner.titlePreparation = undefined;
      }
    };
  });
  // Both draft presentations share one preparation per revision, not one per binding.
  const options = createMemo(() => page().composerOptions());
  const Draft = () => (
    <NewSessionComposerTextareaContext value={owner.submission.composerTextarea}>
      <DraftBlock
        page={page}
        revision={revision}
        options={options}
        submitting={saving() || page().submission.submitting}
      />
    </NewSessionComposerTextareaContext>
  );
  onSettled(() => {
    const document = host.ownerDocument;
    const stops = [
      installChatComposerPickerDismissal(document),
      listen(
        document,
        "keydown",
        (event) =>
          focusChatComposerFromKeydown(
            host,
            event,
            owner.submission.composerTextarea.getTextarea(),
          ),
        true,
      ),
      listen(document.defaultView!, "beforeunload", owner.flushDraft),
      // Submit mounts the deferred preview and composer; fetch them on first
      // intent so the page never flashes their loading fallbacks.
      ...(["pointerdown", "keydown"] as const).map((type) =>
        listen(host, type, preloadSubmissionViews, { capture: true, once: true }),
      ),
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
  const lightbox = () => page().imageLightbox;
  const panelContent = () => {
    const attachment = panel();
    return attachment ? { ...attachment.content } : null;
  };
  // The draft binds Gateway facts before its first child reads defaults.
  return (
    <Show when={initialConnectionReady()}>
      {(_ready) => {
        onSettled(() => {
          renderedPages.add(host);
        });
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
                error={submissionError()}
                pendingMessage={page().submission.pendingMessage}
                userId={userId()}
                submitting={saving() || page().submission.submitting}
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
                    fallback={(error, reset) => (
                      <LazyViewError error={error()} onRetry={reset} inline />
                    )}
                  >
                    <Loading fallback={<LoadingState />}>
                      <CreationComposer
                        composer={composer()}
                        onOpenImage={owner.setImageLightbox}
                      />
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
              {(_attachment) => {
                const content = children(() => (
                  <AttachmentDetailPanel
                    content={panelContent()}
                    onChat-detail-panel-close={owner.closeAttachmentPanel}
                  />
                ));
                const loading = () => <div role="status">{t("common.loading")}</div>;
                return (
                  <aside class="new-session-attachment-panel">
                    <Errored
                      fallback={(error, reset) => {
                        let active = true;
                        const [retrying, setRetrying] = createSignal(false);
                        const stale = isStaleChunkImportError(error());
                        const canRetry = () =>
                          active && owner.isConnected && owner.attachmentPanel !== null;
                        onSettled(() => () => {
                          active = false;
                          if (stale) {
                            cancelStaleChunkRecovery();
                          }
                        });
                        const retry = async () => {
                          if (!canRetry()) {
                            return;
                          }
                          setRetrying(true);
                          if (
                            stale &&
                            (await retryStaleChunkReloadWhenReachable({ canReload: canRetry }))
                          ) {
                            return;
                          }
                          if (canRetry()) {
                            setRetrying(false);
                            reset();
                          }
                        };
                        return (
                          <Show when={!retrying() && !isPending(content)} fallback={loading()}>
                            <LazyViewError
                              error={error()}
                              stale={stale}
                              onRetry={() => void retry()}
                              onClose={owner.closeAttachmentPanel}
                            />
                          </Show>
                        );
                      }}
                    >
                      <Loading fallback={loading()}>{content()}</Loading>
                    </Errored>
                  </aside>
                );
              }}
            </Show>
          </>
        );
      }}
    </Show>
  );
}

defineSolidBridge<
  { data: NewSessionRouteData | undefined },
  {
    focusComposer(): void;
  }
>("openclaw-new-session-page", PageContent, {
  properties: { data: { default: undefined, attribute: false } },
  propertyChanged: (host) => {
    const owner = pageOwners.get(host);
    owner?.retireSubmissionPresentation();
    owner?.browser.close();
    owner?.changed();
  },
  disconnected: (host) => {
    const owner = pageOwners.get(host);
    owner?.retireSubmissionPresentation();
    owner?.browser.close();
  },
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
