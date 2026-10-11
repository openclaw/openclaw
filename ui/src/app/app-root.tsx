import type { ControlUiFocusTarget } from "@openclaw/session-url-contract";
import { render, type JSX as SolidJSX } from "@solidjs/web";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  untrack,
} from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/link-reader-hovercard-registration.ts";
import { renderLazyElementState, renderLazyViewError } from "../components/lazy-view-error.ts";
import { renderConnectingSplash } from "../components/loading-skeleton.ts";
import { installTitleTooltips } from "../components/tooltip-title.ts";
import { i18n } from "../i18n/index.ts";
import {
  projectAgentSelection,
  projectApplicationConfig,
  projectGateway,
} from "../lib/reactive/application.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { projectI18n } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { projectTheme } from "../lib/reactive/theme.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import "./app-shell-locale-recovery.ts";
import { loadFocusDashboard, type FocusDashboardRouteState } from "./app-root-focus.ts";
import { connectLegacyApplicationContext, createLegacyFocusEscape } from "./app-root-lit.ts";
import { ShellLoader } from "./app-shell-loader.tsx";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import type { ControlUiReadiness } from "./control-ui-readiness.ts";
import {
  APPROVAL_PAGE_ELEMENT,
  BROWSER_DOCUMENT_ELEMENT,
  DASHBOARD_DOCUMENT_ELEMENT,
  DESKTOP_PANEL_ELEMENT,
  isOptionalElementDefined,
  LazyCustomElementRequestController,
  LOGIN_GATE_ELEMENT,
  type OptionalCustomElement,
  QUESTION_PAGE_ELEMENT,
  TERMINAL_PANEL_ELEMENT,
} from "./lazy-custom-element.ts";
import { availableLinkReaders, availableLinkPreviewReaders } from "./link-reader-routing.ts";
import { LitRouteHost } from "./lit-route-host.tsx";
import { nativeEmbedHost, isNativeWebChromeHost } from "./native-web-chrome.ts";
import { resolveOnboardingMode } from "./onboarding-mode.ts";
import { isDesktopPanelAvailable } from "./panel-availability.ts";
import { resolveGatewayCredentialsForUrlEdit } from "./settings.ts";
import { connectShellViewport } from "./shell-viewport.ts";

/** Mount into index.html's plain host; the returned disposer owns this application epoch. */
export function mountOpenClawApp(host: HTMLElement, runtime = bootstrapApplication()): () => void {
  return render(() => <OpenClawApp host={host} runtime={runtime} />, host);
}

export function OpenClawApp(props: {
  host: HTMLElement;
  runtime: ApplicationRuntime;
}): SolidJSX.Element {
  // The bootstrap epoch and its DOM host stay fixed until this root is disposed.
  const runtime = untrack(() => props.runtime);
  const host = untrack(() => props.host);
  const context = runtime.context;
  const rootOwner = getOwner();
  let readiness: ControlUiReadiness | undefined;
  let readinessLoad: Promise<void> | undefined;
  const translations = projectI18n(i18n);
  const t = translations.t;
  const gateway = projectGateway(context.gateway);
  const config = projectApplicationConfig(context.config);
  const selection = projectAgentSelection(context.agentSelection);
  const router = projectSource(context.router, {
    read: (source) => source.getState(),
    subscribe: (source, notify) => source.subscribe(notify),
    equality: "revision",
  });
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
  const [loginGatePinned, setLoginGatePinned] = createSignal(false);
  const [loginGatewayUrl, setLoginGatewayUrl] = createSignal(context.gateway.connection.gatewayUrl);
  const [loginToken, setLoginToken] = createSignal(context.gateway.connection.token);
  const [loginPassword, setLoginPassword] = createSignal(context.gateway.connection.password);
  const [loginShowGatewaySecret, setLoginShowGatewaySecret] = createSignal(false);
  const [pendingGatewayUrl, setPendingGatewayUrl] = createSignal(
    runtime.pendingGatewayConnection?.gatewayUrl ?? null,
  );
  const [focusDashboardRoute, setFocusDashboardRoute] = createSignal<FocusDashboardRouteState>({
    kind: "loading",
  });
  const [lazyRevision, setLazyRevision] = createSignal(0);
  let active = true;
  let loginConnectionClient: GatewayBrowserClient | null = context.gateway.snapshot.client;
  const focusDashboardAbort = new AbortController();
  const closeDocument = () => {
    if (globalThis.history.length > 1) {
      globalThis.history.back();
    } else {
      globalThis.location.assign(context.basePath || "/");
    }
  };
  const renderFocusEscape = createLegacyFocusEscape(closeDocument);
  const lazyHost = {
    requestUpdate: () => setLazyRevision((value) => value + 1),
    get updateComplete() {
      return Promise.resolve();
    },
    queryRenderedElement: (tag: string) => host.querySelector(tag),
  };
  const loginGateLoader = new LazyCustomElementRequestController(lazyHost);
  const lazyCustomElements = new LazyCustomElementRequestController(lazyHost, closeDocument);
  const lazyState = () => {
    lazyRevision();
    return lazyCustomElements.visibleState;
  };
  const loginLoadState = () => {
    lazyRevision();
    return loginGateLoader.visibleState;
  };
  const disconnectLegacyContext = connectLegacyApplicationContext(host, context);
  const disconnectViewport = connectShellViewport();
  const disconnectTooltips = installTitleTooltips(host.ownerDocument);
  const embedHost = nativeEmbedHost();
  host.ownerDocument.documentElement.classList.toggle("openclaw-native-embed", embedHost !== null);
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

  createEffect(
    () => gateway.read(),
    (current) => {
      if (current.snapshot.client !== loginConnectionClient) {
        loginConnectionClient = current.snapshot.client;
        setLoginShowGatewaySecret(false);
        setLoginGatewayUrl(current.connection.gatewayUrl);
        setLoginToken(current.connection.token);
        setLoginPassword(current.connection.password);
      }
      if (current.snapshot.phase === "connected") {
        setLoginGatePinned(false);
      }
    },
  );

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
        browserSignInRecovery ||
        snapshot().phase === "reconnecting" ||
        snapshot().phase === "reload-required" ||
        warmConnectPending()
      )
    );
  };
  createEffect(
    () => !focusTarget && !runtime.focusLocation && !coldPending() && showLoginGate(),
    (show) => {
      if (show && !isOptionalElementDefined(LOGIN_GATE_ELEMENT) && !loginGateLoader.visibleState) {
        loginGateLoader.preload(LOGIN_GATE_ELEMENT, { reportError: true });
      }
    },
  );

  const loadReadiness = () => {
    if (active && !readiness && !readinessLoad) {
      readinessLoad = import("./control-ui-readiness-solid.ts")
        .then(({ createSolidControlUiReadiness }) => {
          if (active) {
            readiness = runWithOwner(rootOwner, () =>
              createSolidControlUiReadiness(host, runtime, trackRoot),
            );
          }
        })
        .catch((error: unknown) => {
          if (active) {
            readinessLoad = undefined;
            console.error("[openclaw] automation readiness could not load", error);
          }
        });
    }
    return readiness?.hook;
  };
  const window = host.ownerDocument.defaultView;
  if (window) {
    Object.defineProperty(window, "openclawControlUi", {
      configurable: true,
      get: loadReadiness,
    });
  }
  // The lazy observer reads these current facts only after automation requests it.
  function trackRoot(): void {
    gateway.revision();
    router.revision();
    selection.revision();
    lazyRevision();
    startupPending();
    loginGatePinned();
    loginGatewayUrl();
    loginToken();
    loginPassword();
    loginShowGatewaySecret();
    pendingGatewayUrl();
    focusDashboardRoute();
    config.revision();
    theme.preferences.revision();
    theme.appliedPalette.revision();
  }

  onSettled(() => {
    if (focusTarget) {
      const element = {
        terminal: TERMINAL_PANEL_ELEMENT,
        desktop: DESKTOP_PANEL_ELEMENT,
        browser: BROWSER_DOCUMENT_ELEMENT,
        dashboard: DASHBOARD_DOCUMENT_ELEMENT,
      }[focusTarget.kind];
      if (!isOptionalElementDefined(element)) {
        lazyCustomElements.request(element);
      }
    }
    if (runtime.documentMode) {
      const element =
        runtime.documentMode.kind === "approval" ? APPROVAL_PAGE_ELEMENT : QUESTION_PAGE_ELEMENT;
      if (!isOptionalElementDefined(element)) {
        lazyCustomElements.request(element);
      }
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
          const result = await loadFocusDashboard(context, focusTarget, focusDashboardAbort.signal);
          if (!focusDashboardAbort.signal.aborted) {
            setFocusDashboardRoute(result);
          }
        }
      })
      .catch((error: unknown) => console.error("[openclaw] application start failed", error));
  });
  onCleanup(() => {
    active = false;
    readiness?.disconnect();
    if (
      window &&
      Object.getOwnPropertyDescriptor(window, "openclawControlUi")?.get === loadReadiness
    ) {
      delete window.openclawControlUi;
    }
    gateway.dispose();
    config.dispose();
    selection.dispose();
    router.dispose();
    theme.dispose();
    translations.dispose();
    disconnectViewport();
    disconnectTooltips();
    disconnectLegacyContext();
    focusDashboardAbort.abort();
    lazyCustomElements.abandon();
    loginGateLoader.abandon();
    runtime.stop();
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
      <LitRouteHost
        renderValue={() => {
          translations.revision();
          return renderConnectingSplash(startupStatus());
        }}
      />
    );
  }
  function LazyDocument(documentProps: { element: OptionalCustomElement }): SolidJSX.Element {
    return (
      <Show when={lazyState()?.element === documentProps.element && lazyState()}>
        {(state) => (
          <main class="connect-splash">
            <LitRouteHost
              renderValue={() => {
                translations.revision();
                return renderLazyElementState(
                  state(),
                  () => lazyCustomElements.retry(),
                  () => lazyCustomElements.close(),
                );
              }}
            />
          </main>
        )}
      </Show>
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
    const owner = () => selection.read().state.selectedId ?? snapshot().assistantAgentId;
    const agentId = () => {
      const id = owner();
      return id ? normalizeAgentId(id) : null;
    };
    const themeMode = () => {
      theme.preferences.revision();
      theme.appliedPalette.revision();
      return context.theme.resolvedMode;
    };
    return (
      <>
        <Show
          when={terminal()}
          fallback={
            <openclaw-desktop-panel
              prop:client={connected() ? snapshot().client : null}
              prop:sessions={context.sessions}
              prop:available={available()}
              prop:documentMode={true}
              prop:requestedSource={
                panelProps.target.kind === "desktop" &&
                panelProps.target.selector?.kind === "source"
                  ? panelProps.target.selector.value
                  : null
              }
              prop:sessionKey={
                panelProps.target.kind === "desktop" &&
                panelProps.target.selector?.kind === "session"
                  ? panelProps.target.selector.value
                  : null
              }
              prop:documentControl={
                panelProps.target.kind === "desktop" ? panelProps.target.control : undefined
              }
              prop:onDocumentClose={closeDocument}
            />
          }
        >
          <openclaw-terminal-panel
            prop:client={connected() ? snapshot().client : null}
            prop:available={available()}
            prop:agentId={agentId()}
            prop:themeMode={themeMode()}
            fullscreen
          />
          <openclaw-toast-host />
        </Show>
        <Show when={!connected() && snapshot().lastError === null}>
          <Splash />
        </Show>
        <Show when={available()}>
          <LazyDocument element={terminal() ? TERMINAL_PANEL_ELEMENT : DESKTOP_PANEL_ELEMENT} />
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
  function FocusDashboard(): SolidJSX.Element {
    const failure = createMemo(() => {
      const route = focusDashboardRoute();
      return route.kind === "error" || route.kind === "not-found" ? route : undefined;
    });
    const failureMessage = () => {
      const route = failure();
      return route?.kind === "error"
        ? t("dashboardDocument.loadFailed", { error: route.message })
        : t("dashboardDocument.notFound");
    };
    const ambiguous = createMemo(() => {
      const route = focusDashboardRoute();
      return route.kind === "ambiguous" ? route.data : undefined;
    });
    const session = createMemo(() => {
      const route = focusDashboardRoute();
      return route.kind === "session" ? route.data : undefined;
    });
    return (
      <Switch>
        <Match when={focusDashboardRoute().kind === "loading"}>
          <Splash />
        </Match>
        <Match when={failure()}>
          {(route) => (
            <main class="board-document">
              <section
                class={
                  route().kind === "error"
                    ? "board-document__state board-document__state--error stack"
                    : "board-document__state stack"
                }
                role={route().kind === "error" ? "alert" : "status"}
              >
                <span>{failureMessage()}</span>
                <Escape label={t("dashboardDocument.close")} />
              </section>
            </main>
          )}
        </Match>
        <Match when={ambiguous()}>
          {(data) => (
            <main class="board-document">
              <section class="card board-document__state">
                <h2>{t("chat.sessionRoute.chooseTitle")}</h2>
                <p>
                  {data().candidates.length > 1
                    ? t("chat.sessionRoute.multipleMatches", { shortId: data().shortId })
                    : t("chat.sessionRoute.additionalMatches")}
                </p>
                <For each={data().candidates}>
                  {(candidate) => (
                    <p>
                      <a href={candidate.href}>{candidate.displayName}</a>
                      <br />
                      <small>
                        {candidate.agentId} · {candidate.idPrefix}
                      </small>
                    </p>
                  )}
                </For>
                <Show when={data().truncated}>
                  <p>
                    <small>{t("chat.sessionRoute.additionalMatches")}</small>
                  </p>
                </Show>
                <Escape label={t("dashboardDocument.close")} />
              </section>
            </main>
          )}
        </Match>
        <Match when={session()}>
          {(data) => (
            <>
              <openclaw-board-document
                prop:gatewaySnapshot={snapshot()}
                prop:sessions={context.sessions}
                prop:sessionKey={data().sessionKey}
                prop:preparedSession={
                  data().agentId ? { sessionKey: data().sessionKey, agentId: data().agentId } : null
                }
                prop:onDocumentClose={isNativeWebChromeHost() ? null : closeDocument}
              />
              <Show when={!connected() && snapshot().lastError === null}>
                <Splash />
              </Show>
              <Show when={connected()}>
                <LazyDocument element={DASHBOARD_DOCUMENT_ELEMENT} />
              </Show>
            </>
          )}
        </Match>
      </Switch>
    );
  }
  function Login(): SolidJSX.Element {
    const registered = () => {
      lazyRevision();
      return isOptionalElementDefined(LOGIN_GATE_ELEMENT);
    };
    return (
      <Show
        when={registered()}
        fallback={
          <Show
            when={loginLoadState()?.status === "error" && loginLoadState()}
            fallback={<Splash />}
          >
            {(state) => (
              <LitRouteHost
                renderValue={() => {
                  translations.revision();
                  const current = state();
                  return current.status === "error"
                    ? renderLazyViewError({
                        error: current.error,
                        stale: current.stale,
                        onRetry: () => loginGateLoader.retry(),
                      })
                    : undefined;
                }}
              />
            )}
          </Show>
        }
      >
        <openclaw-login-gate
          prop:props={{
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
      </Show>
    );
  }
  function Shell(): SolidJSX.Element {
    return (
      <openclaw-link-reader-hovercard-provider
        prop:client={connected() ? snapshot().client : null}
        prop:readers={availableLinkPreviewReaders(snapshot())}
        prop:claimedReaders={availableLinkReaders(snapshot())}
        prop:pagePreviewContext={context}
        prop:agentId={selection.read().state.selectedId ?? snapshot().assistantAgentId ?? undefined}
      >
        <openclaw-session-progress-hovercard-provider
          prop:client={snapshot().client}
          prop:context={context}
          prop:gateway={context.gateway}
        >
          <ShellLoader
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
    <ApplicationProvider value={context}>
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
              <>
                <openclaw-browser-document
                  prop:props={{
                    context,
                    target: target(),
                    renderEscape: renderFocusEscape,
                  }}
                />
                <LazyDocument element={BROWSER_DOCUMENT_ELEMENT} />
              </>
            )}
          </Match>
          <Match when={panelTarget}>{(target) => <FocusPanels target={target()} />}</Match>
          <Match when={focusTarget?.kind === "dashboard"}>
            <FocusDashboard />
          </Match>
          <Match when={coldPending()}>
            <Splash />
          </Match>
          <Match when={showLoginGate()}>
            <Login />
          </Match>
          <Match when={runtime.documentMode}>
            {(mode) => {
              const documentMode = untrack(mode);
              const element =
                documentMode.kind === "approval" ? APPROVAL_PAGE_ELEMENT : QUESTION_PAGE_ELEMENT;
              return (
                <Show when={!(documentMode.kind === "approval" && pendingGatewayUrl())}>
                  <Show
                    when={lazyState()?.element === element}
                    fallback={
                      documentMode.kind === "approval" ? (
                        <openclaw-approval-page prop:approvalId={documentMode.approvalId ?? ""} />
                      ) : (
                        <openclaw-question-page prop:questionId={documentMode.questionId ?? ""} />
                      )
                    }
                  >
                    <LazyDocument element={element} />
                  </Show>
                </Show>
              );
            }}
          </Match>
          <Match when={true}>
            <Shell />
          </Match>
        </Switch>
        <Show when={pendingGatewayUrl()}>
          {(url) => (
            <openclaw-gateway-url-confirmation
              prop:props={{
                pendingGatewayUrl: url(),
                currentGatewayUrl: context.gateway.connection.gatewayUrl,
                linkCarriesToken: Boolean(runtime.pendingGatewayConnection?.token),
                onConfirm: () => {
                  runtime.confirmPendingGatewayConnection();
                  setPendingGatewayUrl(null);
                },
                onCancel: () => {
                  runtime.cancelPendingGatewayConnection();
                  setPendingGatewayUrl(null);
                },
              }}
            />
          )}
        </Show>
      </openclaw-tooltip-provider>
    </ApplicationProvider>
  );
}
