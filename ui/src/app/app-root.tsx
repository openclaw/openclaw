import "../lib/toast-host.tsx";
import type { ControlUiFocusTarget } from "@openclaw/session-url-contract";
import { render, type JSX as SolidJSX } from "@solidjs/web";
import {
  Errored,
  Loading,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  lazy,
  onSettled,
  type Element,
} from "solid-js";
import "../components/link-reader-hovercard-registration.ts";
import { LazyViewError } from "../components/solid/lazy-view-error.tsx";
import { ConnectingSplash } from "../components/solid/loading-skeleton.tsx";
import { LoadingState } from "../components/solid/loading-state.tsx";
import { installTitleTooltips } from "../components/tooltip-title.ts";
import { i18n } from "../i18n/index.ts";
import {
  projectAgentSelection,
  projectApplicationConfig,
  projectGateway,
} from "../lib/reactive/application.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { connectedElementRef, elementRef } from "../lib/reactive/element-ref.ts";
import { projectI18n } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { projectTheme } from "../lib/reactive/theme.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import "./app-shell-locale-recovery.ts";
import type { FocusDashboardRouteState } from "./app-root-focus.ts";
import { createLegacyFocusEscape } from "./app-root-lit.ts";
import { ShellLoader } from "./app-shell-loader.tsx";
import { adoptBootComposer } from "./boot-composer.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import type {
  createSolidControlUiReadiness,
  SolidReadinessShell,
} from "./control-ui-readiness-solid.ts";
import type { ControlUiReadiness } from "./control-ui-readiness.ts";
import { availableLinkReaders, availableLinkPreviewReaders } from "./link-reader-routing.ts";
import { nativeEmbedHost, isNativeWebChromeHost } from "./native-web-chrome.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { isDesktopPanelAvailable } from "./panel-availability.ts";
import { isRemoteControlUiIngress } from "./remote-ingress.ts";
import { resolveGatewayCredentialsForUrlEdit } from "./settings.ts";
import { connectShellViewport } from "./shell-viewport.ts";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "./stale-chunk-reload.ts";

const GatewayUrlConfirmation = lazy(
  () => import("../components/solid/gateway-url-confirmation.tsx"),
  { export: "GatewayUrlConfirmation" },
);

const FocusDashboard = lazy(() => import("./app-root-focus-view.tsx"), {
  export: "FocusDashboard",
});

const TerminalPanel = lazy(() => import("../components/terminal/terminal-panel-registration.tsx"), {
  export: "TerminalPanelHost",
});
const DesktopPanel = lazy(() => import("../components/desktop/desktop-panel-solid.tsx"), {
  export: "DesktopPanel",
});
const BrowserDocument = lazy(() => import("../components/browser/browser-document.tsx"), {
  export: "BrowserDocument",
});
const BoardDocument = lazy(() => import("../components/board/board-document.tsx"), {
  export: "OpenClawBoardDocument",
});
// Approval validators stay behind document URLs, outside the normal startup graph.
const ApprovalPage = lazy(() => import("../pages/approval/approval-page.tsx"), {
  export: "ApprovalPage",
});
const QuestionPage = lazy(() => import("../pages/question/question-page.tsx"), {
  export: "QuestionPage",
});
const LoginGate = lazy(() => import("../components/login-gate-solid.tsx"), {
  export: "LoginGate",
});

/** Mount into index.html's plain host; the returned disposer owns this application epoch. */
export function mountOpenClawApp(host: HTMLElement, runtime = bootstrapApplication()): () => void {
  // The boot frame's composer survives its frame; Solid's loading frames reinsert it.
  adoptBootComposer(runtime.documentMode === null && runtime.focusLocation === null);
  // render() appends to existing children; retire the HTML frame in the same
  // task as the first Solid commit so it cannot remain beside the live app.
  host.replaceChildren();
  return render(() => OpenClawApp(host, runtime), host);
}

function OpenClawApp(host: HTMLElement, runtime: ApplicationRuntime): SolidJSX.Element {
  const context = runtime.context;
  let readiness: ControlUiReadiness | undefined;
  let readinessLoad: Promise<void> | undefined;
  const [readinessRequest, setReadinessRequest] = createSignal<{
    create: typeof createSolidControlUiReadiness;
  }>();
  let shell: SolidReadinessShell | undefined;
  const login = connectedElementRef<HTMLElement>();
  const terminalElement = connectedElementRef<HTMLElement & { readonly available?: boolean }>();
  const translations = projectI18n(i18n);
  const t = translations.t;
  const gateway = projectGateway(context.gateway);
  const config = projectApplicationConfig(context.config);
  const selection = projectAgentSelection(context.agentSelection);
  const router = projectOwner(context.router, (source) => source.getState());
  const theme = projectTheme(context.theme);
  const snapshot = () => gateway.read().snapshot;
  const connected = () => snapshot().phase === "connected";
  const startupStatus = () =>
    snapshot().phase === "starting" ? t("common.gatewayStarting") : undefined;
  const focusTarget =
    runtime.focusLocation?.status === "valid" ? runtime.focusLocation.target : null;
  const panelTarget =
    focusTarget?.kind === "terminal" || focusTarget?.kind === "desktop" ? focusTarget : null;
  const onboarding = resolveOnboardingMode(globalThis.location?.search ?? "");
  const [startupPending, setStartupPending] = createSignal(true);
  // A submitted login keeps ownership until the Gateway admits the connection.
  const [loginGatePinned, setLoginGatePinned] = createSignal<boolean>(
    (previous) => !connected() && (previous ?? false),
  );
  // Drafts reset only for a replacement client, not same-client status publications.
  const loginConnection = createMemo(
    () => {
      const current = gateway.read();
      return { client: current.snapshot.client, ...current.connection };
    },
    { equals: (previous, next) => previous.client === next.client },
  );
  const [loginGatewayUrl, setLoginGatewayUrl] = createSignal(() => loginConnection().gatewayUrl);
  const [loginToken, setLoginToken] = createSignal(() => loginConnection().token);
  const [loginPassword, setLoginPassword] = createSignal(() => loginConnection().password);
  const [loginShowGatewaySecret, setLoginShowGatewaySecret] = createSignal(() => {
    loginConnection();
    return false;
  });
  const [pendingGatewayUrl, setPendingGatewayUrl] = createSignal(
    runtime.pendingGatewayConnection?.gatewayUrl ?? null,
  );
  const cancelPendingGatewayConnection = () => {
    runtime.cancelPendingGatewayConnection();
    setPendingGatewayUrl(null);
  };
  const focusDashboardRoute = Promise.withResolvers<FocusDashboardRouteState>();
  let active = true;
  const focusDashboardAbort = new AbortController();
  const closeDocument = () => {
    if (globalThis.history.length > 1) {
      globalThis.history.back();
    } else {
      globalThis.location.assign(context.basePath || "/");
    }
  };
  const renderFocusEscape = createLegacyFocusEscape(closeDocument);
  const notifyMounted = (element: HTMLElement) => {
    // Lazy hosts commit after the root's initial readiness observation.
    queueMicrotask(() => {
      if (active && element.isConnected) {
        readiness?.invalidate();
      }
    });
  };

  const initialConnectPending = () =>
    runtime.documentMode === null &&
    snapshot().lastError === null &&
    ((startupPending() && snapshot().phase === "stopped") ||
      snapshot().phase === "starting" ||
      (snapshot().phase === "connecting" && !loginGatePinned()));
  const warmConnectPending = () =>
    runtime.documentMode === null &&
    runtime.warmBoot &&
    !loginGatePinned() &&
    (initialConnectPending() ||
      (snapshot().phase === "connecting" &&
        !snapshot().lastErrorAuthReason &&
        (snapshot().lastErrorCode === null || snapshot().lastErrorCode === "GATEWAY_BUSY")));
  const coldPending = () => initialConnectPending() && !warmConnectPending();
  const showLoginGate = () => {
    const route = router.read();
    const browserSignInRecovery =
      (route.pendingMatches[0] ?? route.matches[0])?.routeId === "connection" &&
      (context.gateway.hasStoredDeviceToken?.() ?? false);
    return (
      !connected() &&
      !(
        isRemoteControlUiIngress() ||
        browserSignInRecovery ||
        snapshot().phase === "reconnecting" ||
        snapshot().phase === "reload-required" ||
        warmConnectPending()
      )
    );
  };
  const loadReadiness = () => {
    if (active && !readiness && !readinessLoad) {
      readinessLoad = import("./control-ui-readiness-solid.ts")
        .then(({ createSolidControlUiReadiness }) => {
          if (active) {
            setReadinessRequest({ create: createSolidControlUiReadiness });
          }
        })
        .catch(readinessFailed);
    }
    return readiness?.hook;
  };
  function readinessFailed(error: unknown): void {
    if (active) {
      readinessLoad = undefined;
      console.error("[openclaw] automation readiness could not load", error);
    }
  }
  const window = host.ownerDocument.defaultView;
  // The lazy observer reads these current facts only after automation requests it.
  function trackRoot(): void {
    gateway.revision();
    router.revision();
    selection.revision();
    startupPending();
    loginGatePinned();
    loginGatewayUrl();
    loginToken();
    loginPassword();
    loginShowGatewaySecret();
    pendingGatewayUrl();
    config.revision();
    theme.preferences.revision();
    theme.appliedPalette.revision();
  }

  onSettled(() => {
    const disconnectViewport = connectShellViewport();
    const disconnectTooltips = installTitleTooltips(host.ownerDocument);
    const embedHost = nativeEmbedHost();
    host.ownerDocument.documentElement.classList.toggle(
      "openclaw-native-embed",
      embedHost !== null,
    );
    host.toggleAttribute(
      "data-native-titlebar",
      embedHost?.platform === "macos" &&
        embedHost.formFactor === "desktop" &&
        embedHost.surface === "conversation",
    );
    if (embedHost) {
      void import("../styles/native-embed.css");
    }
    void import("../components/session-progress-hovercard-registration.ts");
    if (window) {
      Object.defineProperty(window, "openclawControlUi", {
        configurable: true,
        get: loadReadiness,
      });
    }
    if (focusTarget) {
      const component = {
        terminal: TerminalPanel,
        desktop: DesktopPanel,
        browser: BrowserDocument,
        dashboard: BoardDocument,
      }[focusTarget.kind];
      // Start at the original registration boundary; the rendered boundary owns errors.
      void component.preload().catch(() => {});
    }
    if (runtime.documentMode) {
      const component = runtime.documentMode.kind === "approval" ? ApprovalPage : QuestionPage;
      void component.preload().catch(() => {});
    }
    globalThis.dispatchEvent(new Event("openclaw-control-ui-rendered"));
    void runtime
      .start()
      .finally(() => {
        if (active) {
          setStartupPending(false);
        }
      })
      .then(async () => {
        if (active && focusTarget?.kind === "dashboard") {
          const { loadFocusDashboard } = await import("./app-root-focus.ts");
          if (focusDashboardAbort.signal.aborted) {
            return;
          }
          const result = await loadFocusDashboard(context, focusTarget, focusDashboardAbort.signal);
          if (!focusDashboardAbort.signal.aborted) {
            focusDashboardRoute.resolve(result);
          }
        }
      })
      .catch((error: unknown) => console.error("[openclaw] application start failed", error));
    return () => {
      active = false;
      readiness?.disconnect();
      if (
        window &&
        Object.getOwnPropertyDescriptor(window, "openclawControlUi")?.get === loadReadiness
      ) {
        delete window.openclawControlUi;
      }
      disconnectViewport();
      disconnectTooltips();
      focusDashboardAbort.abort();
      runtime.stop();
    };
  });

  function Escape(escapeProps: { label: string }): SolidJSX.Element {
    return (
      <Show when={!isNativeWebChromeHost()}>
        <button class="btn btn--ghost" type="button" onClick={closeDocument}>
          {escapeProps.label}
        </button>
      </Show>
    );
  }
  function Splash(): SolidJSX.Element {
    return (
      <openclaw-route-fragment style={{ display: "contents" }}>
        <ConnectingSplash status={startupStatus()} />
      </openclaw-route-fragment>
    );
  }
  function DocumentLoading(): SolidJSX.Element {
    return (
      <main class="connect-splash">
        <openclaw-route-fragment style={{ display: "contents" }}>
          <LoadingState />
        </openclaw-route-fragment>
      </main>
    );
  }
  function LoadFailure(props: {
    error: unknown;
    reset: () => void;
    label?: string;
    onClose?: () => void;
  }): SolidJSX.Element {
    let current = true;
    const stale = () => isStaleChunkImportError(props.error);
    const retire = () => {
      current = false;
      if (stale()) {
        cancelStaleChunkRecovery();
      }
    };
    onSettled(() => {
      readiness?.invalidate();
      return retire;
    });
    const retry = async () => {
      if (!stale() || !(await retryStaleChunkReloadWhenReachable({ canReload: () => current }))) {
        if (current) {
          props.reset();
        }
      }
    };
    const content = () => (
      <openclaw-route-fragment style={{ display: "contents" }}>
        <LazyViewError
          actionLabel={props.label ? t("common.retry") : undefined}
          error={props.error}
          stale={stale()}
          subtitle={props.label}
          onRetry={() => void retry()}
          onClose={
            props.onClose
              ? () => {
                  retire();
                  props.onClose?.();
                }
              : undefined
          }
        />
      </openclaw-route-fragment>
    );
    return <>{props.label ? <main class="connect-splash">{content()}</main> : content()}</>;
  }
  function LazyRootBoundary(props: {
    children: Element;
    fallback: Element;
    label?: string;
    visible?: boolean;
    onClose?: () => void;
  }): SolidJSX.Element {
    const [attempt, setAttempt] = createSignal(0);
    return (
      <Loading on={attempt()} fallback={props.fallback}>
        <Errored
          fallback={(error, reset) => (
            <Show when={props.visible ?? true}>
              <LoadFailure
                error={error()}
                reset={() => {
                  setAttempt((value) => value + 1);
                  reset();
                }}
                label={props.label}
                onClose={props.onClose}
              />
            </Show>
          )}
        >
          {props.children}
        </Errored>
      </Loading>
    );
  }
  function FocusPanels(panelProps: {
    target: Extract<ControlUiFocusTarget, { kind: "terminal" | "desktop" }>;
  }): SolidJSX.Element {
    const terminal = () => panelProps.target.kind === "terminal";
    const available = () =>
      terminal()
        ? isTerminalAvailable(snapshot(), config.read().terminalEnabled ?? false)
        : isDesktopPanelAvailable(snapshot());
    const agentId = () => {
      const id = selection.read().state.selectedId ?? snapshot().assistantAgentId;
      return id ? normalizeAgentId(id) : null;
    };
    const themeMode = () => {
      theme.preferences.revision();
      theme.appliedPalette.revision();
      return context.theme.resolvedMode;
    };
    return (
      <>
        <LazyRootBoundary
          label={terminal() ? "terminal panel" : "desktop panel"}
          fallback={available() ? <DocumentLoading /> : undefined}
          visible={available()}
          onClose={closeDocument}
        >
          <Show
            when={terminal()}
            fallback={
              <DesktopPanel
                client={connected() ? snapshot().client : null}
                sessions={context.sessions}
                available={available()}
                documentMode={true}
                requestedSource={
                  panelProps.target.kind === "desktop" &&
                  panelProps.target.selector?.kind === "source"
                    ? panelProps.target.selector.value
                    : null
                }
                sessionKey={
                  panelProps.target.kind === "desktop" &&
                  panelProps.target.selector?.kind === "session"
                    ? panelProps.target.selector.value
                    : null
                }
                documentControl={
                  panelProps.target.kind === "desktop" ? panelProps.target.control : undefined
                }
                onDocumentClose={closeDocument}
              />
            }
          >
            <TerminalPanel
              ref={[elementRef(terminalElement.bind), notifyMounted]}
              client={snapshot().client}
              gatewayConnected={connected()}
              available={available()}
              agentId={agentId()}
              themeMode={themeMode()}
              fullscreen={true}
            />
            <openclaw-toast-host />
          </Show>
        </LazyRootBoundary>
        <Show when={!connected() && snapshot().lastError === null}>
          <Splash />
        </Show>
        <Show when={!available() && (connected() || snapshot().lastError)}>
          <div class={terminal() ? "terminal-view-unavailable" : "desktop-view-unavailable"}>
            <div class="stack">
              <span>{t(terminal() ? "terminal.unavailable" : "desktop.unavailable")}</span>
              <Escape label={t("common.back")} />
            </div>
          </div>
        </Show>
      </>
    );
  }
  function Login(): SolidJSX.Element {
    return (
      <LazyRootBoundary fallback={<Splash />}>
        <LoginGate
          ref={[elementRef(login.bind), notifyMounted]}
          props={{
            resourceBasePath: context.resourceBasePath,
            branding: context.theme.branding,
            connected: connected(),
            lastError: snapshot().lastError,
            reconnectAt: snapshot().reconnectAt,
            reconnectPending:
              snapshot().lastError !== null &&
              (snapshot().phase === "connecting" || snapshot().phase === "reconnecting"),
            lastErrorCode: snapshot().lastErrorCode,
            lastErrorAuthReason: snapshot().lastErrorAuthReason,
            hasToken: Boolean(loginToken().trim()),
            hasPassword: Boolean(loginPassword().trim()),
            gatewayUrl: loginGatewayUrl(),
            secret: loginToken() || loginPassword(),
            showGatewaySecret: loginShowGatewaySecret(),
            onGatewayUrlChange: (value: string) => {
              const credentials = resolveGatewayCredentialsForUrlEdit(loginGatewayUrl(), value, {
                token: loginToken(),
                password: loginPassword(),
              });
              setLoginGatewayUrl(value);
              setLoginToken(credentials.token);
              setLoginPassword(credentials.password);
            },
            onSecretChange: (value: string) => {
              setLoginToken(value);
              setLoginPassword("");
            },
            onToggleGatewaySecret: () => setLoginShowGatewaySecret((value) => !value),
            onOpenGatewaySettings: context.gateway.hasStoredDeviceToken?.()
              ? () => context.navigate("connection")
              : undefined,
            onConnect: () => {
              setLoginGatePinned(true);
              context.gateway.connect({
                gatewayUrl: loginGatewayUrl(),
                token: loginToken(),
                password: loginPassword(),
              });
            },
          }}
        />
      </LazyRootBoundary>
    );
  }
  function Shell(): SolidJSX.Element {
    return (
      <openclaw-link-reader-hovercard-provider
        prop:client={snapshot().client}
        prop:readers={availableLinkPreviewReaders(snapshot())}
        prop:claimedReaders={availableLinkReaders(snapshot())}
        prop:pagePreviewContext={context}
        prop:agentId={selection.read().state.selectedId ?? snapshot().assistantAgentId ?? undefined}
      >
        <openclaw-session-progress-hovercard-provider
          prop:client={snapshot().client}
          prop:context={context}
          prop:gateway={context.gateway}
          prop:lookupSidebarRow={(sessionKey: string) =>
            shell?.navigationSidebar.findSidebarHovercardRowByKey?.(sessionKey)
          }
        >
          <ShellLoader
            onShell={(owner) => {
              shell = owner;
              runtime.setShell(owner);
              readiness?.invalidate();
            }}
            runtime={runtime}
            getReadiness={() => readiness}
            onboarding={onboarding}
            fallback={<Splash />}
          />
        </openclaw-session-progress-hovercard-provider>
      </openclaw-link-reader-hovercard-provider>
    );
  }
  return (
    <ApplicationProvider value={context} host={host}>
      <Show when={readinessRequest()} keyed>
        {(request) => {
          try {
            readiness = request.create(host, runtime, trackRoot, () => ({
              login: login.read() ?? undefined,
              shell,
              terminal: shell?.element.isConnected
                ? shell.terminalPanel
                : (terminalElement.read() ?? undefined),
            }));
          } catch (error) {
            readinessFailed(error);
          }
          return null;
        }}
      </Show>
      <openclaw-tooltip-provider>
        <Switch>
          <Match when={runtime.focusLocation?.status === "unsupported"}>
            <main class="connect-splash" role="alert">
              <div class="stack">
                <span class="connect-splash__status">{t("focus.unsupported")}</span>
                <Escape label={t("common.back")} />
              </div>
            </main>
          </Match>
          <Match when={focusTarget?.kind === "browser" ? focusTarget : null}>
            {(target) => (
              <LazyRootBoundary
                label="browser panel"
                fallback={<DocumentLoading />}
                onClose={closeDocument}
              >
                <BrowserDocument
                  props={{
                    context,
                    target: target(),
                    renderEscape: renderFocusEscape,
                  }}
                />
              </LazyRootBoundary>
            )}
          </Match>
          <Match when={panelTarget}>{(target) => <FocusPanels target={target()} />}</Match>
          <Match when={focusTarget?.kind === "dashboard"}>
            <LazyRootBoundary
              label="dashboard document"
              fallback={<Splash />}
              onClose={closeDocument}
            >
              <FocusDashboard
                route={focusDashboardRoute.promise}
                onReady={() => readiness?.invalidate()}
                snapshot={snapshot()}
                renderSplash={Splash}
                renderEscape={() => <Escape label={t("dashboardDocument.close")} />}
                renderDocument={(documentProps) => (
                  <BoardDocument
                    {...documentProps}
                    gatewaySnapshot={snapshot()}
                    sessions={context.sessions}
                    onDocumentClose={isNativeWebChromeHost() ? null : closeDocument}
                    ref={notifyMounted}
                  />
                )}
              />
            </LazyRootBoundary>
          </Match>
          <Match when={coldPending()}>
            <Splash />
          </Match>
          <Match when={showLoginGate()}>
            <Login />
          </Match>
          <Match when={runtime.documentMode} keyed>
            {(documentMode) => (
              <Show when={!(documentMode.kind === "approval" && pendingGatewayUrl())}>
                <LazyRootBoundary
                  label={
                    documentMode.kind === "approval" ? "approval page" : "openclaw-question-page"
                  }
                  fallback={<DocumentLoading />}
                  onClose={closeDocument}
                >
                  {documentMode.kind === "approval" ? (
                    <ApprovalPage approvalId={documentMode.approvalId ?? ""} />
                  ) : (
                    <QuestionPage questionId={documentMode.questionId ?? ""} />
                  )}
                </LazyRootBoundary>
              </Show>
            )}
          </Match>
          <Match when={true}>
            <Shell />
          </Match>
        </Switch>
        <Show when={pendingGatewayUrl()}>
          {(url) => (
            <Errored
              fallback={(error, reset) => (
                <LazyViewError
                  error={error()}
                  onRetry={reset}
                  onClose={cancelPendingGatewayConnection}
                />
              )}
            >
              <Loading fallback={<LoadingState />}>
                <GatewayUrlConfirmation
                  props={{
                    pendingGatewayUrl: url(),
                    currentGatewayUrl: context.gateway.connection.gatewayUrl,
                    linkCarriesToken: Boolean(runtime.pendingGatewayConnection?.token),
                    onConfirm: () => {
                      runtime.confirmPendingGatewayConnection();
                      setPendingGatewayUrl(null);
                    },
                    onCancel: cancelPendingGatewayConnection,
                  }}
                />
              </Loading>
            </Errored>
          )}
        </Show>
      </openclaw-tooltip-provider>
    </ApplicationProvider>
  );
}
