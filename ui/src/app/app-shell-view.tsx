import "../lib/toast-host.tsx";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, lazy, onSettled, Show } from "solid-js";
import { registerModalSurface } from "../components/overlay-registry.ts";
import { LazySettingsSidebar } from "../components/settings-sidebar-lazy.tsx";
import { GatewayStatus, gatewayStatusLabel } from "../components/solid/gateway-status.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { ShortcutHint } from "../components/solid/kbd.tsx";
import { ConnectingSplash } from "../components/solid/loading-skeleton.tsx";
import {
  ContextNewSessionAction,
  renderNewSessionLink as NewSessionLink,
} from "../components/solid/new-session-link.tsx";
import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { resolveUiSelectedSessionAgentId } from "../lib/sessions/session-key.ts";
import { registerToastContainer } from "../lib/toast.ts";
import { PluginSurface } from "../plugins/control-ui-view.solid.tsx";
import {
  ShellComponentBoundary,
  ShellRequestedComponent,
} from "./app-shell-component-boundary.tsx";
import type { ShellOwnedElements } from "./app-shell-components.ts";
import { DevicePairSetup } from "./app-shell-device-pair-setup.tsx";
import { ShellDocks } from "./app-shell-docks.tsx";
import { ShellLazyOverlays, type ShellElementAttributes } from "./app-shell-lazy-view.tsx";
import { readShellView, type ShellViewHost } from "./app-shell-view-state.ts";
import { beginNativeWindowDrag, beginNativeWindowDragFromTopInset } from "./native-window-drag.ts";
import { FloatingUpdateCard } from "./navigation-surface-view.tsx";
import { floatingSidebarAttentionVisible } from "./navigation-surface.ts";
import { RouterOutlet } from "./router-outlet.tsx";
import { NAV_WIDTH_MAX, NAV_WIDTH_MIN } from "./settings.ts";
import { CollapsedHomeToggle } from "./shell-assistant-toggles.tsx";
import { ShellLayoutProvider } from "./shell-layout-traits-solid.tsx";

export type { ShellViewHost } from "./app-shell-view-state.ts";

const NavigationSidebar = lazy(async () => {
  await import("../components/app-sidebar.tsx");
  // Keep the native host that callers assign before registration and move between layouts.
  return {
    default: (props: { host: ShellViewHost }) => {
      onSettled(() => props.host.shellComponentMounted(props.host.navigationSidebar));
      return <>{props.host.navigationSidebar}</>;
    },
  };
});

const MacosTitlebarControls = lazy(
  () => import("../components/macos-titlebar-controls.runtime-solid.tsx"),
  { export: "MacosTitlebarControls" },
);
const TerminalPanel = lazy(() => import("../components/terminal/terminal-panel-registration.tsx"), {
  export: "TerminalPanelHost",
});
const ExecApproval = lazy(() => import("../components/exec-approval-solid.tsx"), {
  export: "ExecApproval",
});
const OnboardingMemoryImport = lazy(
  () => import("../components/onboarding-memory-import-solid.tsx"),
  { export: "OnboardingMemoryImport" },
);

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-macos-titlebar-controls": ShellElementAttributes;
      "openclaw-app-topbar": ShellElementAttributes;
      "openclaw-assistant-panel": ShellElementAttributes;
      "openclaw-exec-approval": ShellElementAttributes<
        NonNullable<ShellOwnedElements["approvalOverlay"]>
      >;
      "openclaw-onboarding-memory-import": ShellElementAttributes;
    }
  }
}

export function ApplicationShell(props: {
  host: ShellViewHost & { commitRenderedPresentation(): void };
}): SolidJSX.Element {
  let content!: HTMLElement;
  let releaseNavDrawer: (() => void) | undefined;
  onSettled(() => {
    const stops = [
      props.host.shellElement && registerToastContainer(props.host.shellElement, "shell"),
      props.host.navDrawerElement && registerToastContainer(props.host.navDrawerElement, "drawer"),
    ];
    return () => {
      stops.forEach((stop) => stop?.());
      releaseNavDrawer?.();
    };
  });
  const [navResizing, setNavResizing] = createSignal(false);
  const view = createMemo(() => {
    props.host.shellRevision();
    return readShellView(props.host);
  });
  const sessionOwner = createMemo(() => view().context.sessions);
  const sessionRows = createMemo(() =>
    projectOwner(sessionOwner(), (sessions) => sessions.state.result?.sessions),
  );
  const shellConnectionStatus = createMemo(() => view().shellConnectionStatus);
  const footerStatus = createMemo(() =>
    shellConnectionStatus() || view().connectionRecovery ? view().gatewayStatus : null,
  );
  function NavigationFallback() {
    return (
      <Show when={footerStatus()}>
        <aside class="sidebar">
          <div class="sidebar-shell">
            <div class="sidebar-shell__content" />
            <div class="sidebar-shell__footer">
              <GatewayStatus {...footerStatus()!} row />
            </div>
          </div>
        </aside>
      </Show>
    );
  }
  const connectionAnnouncement = createMemo(() => {
    const kind = shellConnectionStatus();
    return kind
      ? gatewayStatusLabel(kind, view().gatewayStatus.queuedCount)
      : view().gatewayConnected
        ? t("nav.gateway.connected")
        : "";
  });
  // Legacy Mac hosts stamp this immutable host class before mounting the shell.
  // The web-chrome flag remains a reactive view read for the current host path.
  const legacyMacChrome = () =>
    !view().nativeWebChrome && document.documentElement.classList.contains("openclaw-native-macos");
  const workspace = (
    <div style={{ display: "contents" }}>
      <ShellLazyOverlays
        host={props.host}
        revision={props.host.shellRevision()}
        desktopPanelAvailable={view().desktopPanelAvailable}
        custodianPanelAvailable={view().custodianPanelAvailable}
        nativeEmbed={view().nativeEmbed}
      />
      <div
        ref={(element) => (props.host.shellElement = element)}
        class={[
          "shell",
          {
            "shell--navigation-rail": view().railAvailable,
            "shell--chat": view().chatLikeRoute,
            "shell--nav-collapsed": view().navCollapsed,
            "shell--mobile-nav": view().mobileNavLayout,
            "shell--merged-chat-chrome": view().mergedChatChrome,
            "shell--nav-drawer-open": view().navDrawerOpen,
            "shell--onboarding": view().onboarding,
            "shell--embed": view().nativeEmbed,
            "shell--embed-settings": view().embedSettings,
            "shell--settings": view().settingsTakeover,
            "shell--home-control":
              view().collapsedControls && view().homePanelAvailable && !view().railAvailable,
            "shell--floating-attention": floatingSidebarAttentionVisible(view().floatingUpdateCard),
            "shell--nav-resizing": navResizing(),
          },
        ]}
        data-background-managed={
          !view().backgroundReady || view().uiSettings.background !== undefined ? "" : undefined
        }
        style={{
          "--shell-nav-expanded-width": `${view().expandedNavWidth}px`,
          "--shell-nav-rail-width": `${view().railWidth}px`,
        }}
      >
        <a class="shell-skip-link" href="#control-ui-main" inert={view().navDrawerOpen}>
          {t("common.skipToMainContent")}
        </a>
        <Show when={view().nativeWebChrome && !view().onboarding}>
          <ShellComponentBoundary label="openclaw-macos-titlebar-controls">
            <MacosTitlebarControls
              inert={view().navDrawerOpen}
              historyOnly={view().settingsTakeover}
              canGoBack={props.host.nativeHistoryState().canGoBack}
              canGoForward={props.host.nativeHistoryState().canGoForward}
            />
          </ShellComponentBoundary>
        </Show>
        <Show when={!view().nativeEmbed}>
          <openclaw-app-topbar
            inert={view().navDrawerOpen}
            prop:resourceBasePath={view().context.resourceBasePath}
            prop:environment={view().config.environment}
            prop:navDrawerOpen={view().navDrawerOpen}
            prop:gatewayStatus={view().mobileGatewayStatus}
            prop:newSessionAction={() => (
              <Show
                when={
                  view().mobileNavLayout &&
                  !view().mergedChatChrome &&
                  !view().navDrawerOpen &&
                  !view().onboarding &&
                  !view().nativeWebChrome &&
                  !document.documentElement.classList.contains("openclaw-native-nav")
                }
              >
                <ContextNewSessionAction
                  context={view().context}
                  class="header-new-session"
                  agentId={view().selectedAgentId}
                />
              </Show>
            )}
            prop:onOpenPalette={props.host.openPalette}
            prop:onToggleDrawer={props.host.toggleNavigationSurface}
          />
        </Show>
        <Show when={view().collapsedControls}>
          <div class="shell-chrome-controls" onMouseDown={beginNativeWindowDrag}>
            {/* Native hosts retain their window-control expand action; web uses the rail. */}
            <Show when={view().nativeWebChrome || legacyMacChrome()}>
              <openclaw-tooltip>
                <span slot="content">
                  <ShortcutHint
                    label={t("nav.expand")}
                    combo={KEYBOARD_SHORTCUT_COMBOS.toggleSidebar}
                  />
                </span>
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__nav-toggle"
                  aria-label={t("nav.expand")}
                  aria-expanded="false"
                  data-env-avatar={
                    view().config.environment
                      ? view().config.assistantIdentity.name.charAt(0)
                      : undefined
                  }
                  onClick={() => props.host.viewCallbacks.toggleSidebar()}
                >
                  <Icon name="sessionSidebarOpen" />
                </button>
              </openclaw-tooltip>
            </Show>
            <Show when={!view().railAvailable}>
              <NewSessionLink
                basePath={view().context.basePath}
                agentId={view().selectedAgentId}
                class="shell-chrome-controls__button shell-chrome-controls__new-thread"
                label={t("chat.runControls.newSession")}
                showShortcut
                disabledReason={view().newSessionDisabledReason}
                onOpen={props.host.viewCallbacks.requestOpenNewSession}
              />
            </Show>
            <Show when={!view().railAvailable || legacyMacChrome()}>
              <openclaw-tooltip>
                <span slot="content">
                  <ShortcutHint
                    label={t("chat.openCommandPalette")}
                    combo={KEYBOARD_SHORTCUT_COMBOS.commandPalette}
                  />
                </span>
                <button
                  type="button"
                  class="shell-chrome-controls__button shell-chrome-controls__search"
                  aria-label={t("chat.openCommandPalette")}
                  onClick={() => props.host.openPalette()}
                >
                  <Icon name="search" />
                </button>
              </openclaw-tooltip>
            </Show>
            <Show when={view().homePanelAvailable && !view().railAvailable}>
              <CollapsedHomeToggle />
            </Show>
          </div>
        </Show>
        <Show when={!view().nativeEmbed}>
          <button
            type="button"
            ref={(element) => (props.host.navBackdropElement = element)}
            class="shell-nav-backdrop"
            tabindex={-1}
            aria-hidden="true"
            inert={!view().navDrawerOpen}
            onClick={() => props.host.closeNavDrawer({ restoreFocus: true })}
          />
          <div
            ref={(element) => {
              releaseNavDrawer?.();
              releaseNavDrawer = registerModalSurface(element);
              props.host.navDrawerElement = element;
            }}
            class={["shell-nav", { "nav-drawer": view().mobileNavLayout }]}
            role={view().mobileNavLayout ? "dialog" : undefined}
            aria-modal={view().mobileNavLayout && view().navDrawerOpen ? "true" : undefined}
            aria-label={view().mobileNavLayout ? t("palette.categories.navigation") : undefined}
            aria-hidden={
              view().mobileNavLayout && view().navigationSurfaceHidden ? "true" : undefined
            }
            tabindex={view().mobileNavLayout ? -1 : undefined}
            inert={view().navigationSurfaceHidden}
          >
            <Show
              when={view().settingsTakeover}
              fallback={
                <Show when={view().workspaceChromeVisible}>
                  <Show
                    when={(props.host.shellRevision(), !props.host.navigationSidebar.isConnected)}
                  >
                    <NavigationFallback />
                  </Show>
                  <ShellComponentBoundary label={t("palette.categories.navigation")}>
                    <NavigationSidebar host={props.host} />
                  </ShellComponentBoundary>
                </Show>
              }
            >
              <LazySettingsSidebar
                host={props.host}
                sidebarProps={{ ...view().settingsSidebarProps, footerStatus: footerStatus() }}
              />
            </Show>
          </div>
        </Show>
        <Show
          when={
            !view().nativeEmbed &&
            !view().mobileNavLayout &&
            !view().navCollapsed &&
            !view().onboarding &&
            !view().settingsTakeover
          }
        >
          <resizable-divider
            class="sidebar-resizer"
            prop:label={t("nav.resize")}
            prop:splitRatio={view().expandedNavWidth / view().shellWidth}
            prop:minRatio={(NAV_WIDTH_MIN + view().railWidth) / view().shellWidth}
            prop:maxRatio={(NAV_WIDTH_MAX + view().railWidth) / view().shellWidth}
            aria-valuetext={`${view().expandedNavWidth} pixels`}
            onResize-start={() => setNavResizing(true)}
            onResize-end={() => setNavResizing(false)}
            onResize={(event: CustomEvent<{ splitRatio: number }>) =>
              props.host.resizeNavigation(event.detail.splitRatio)
            }
          />
        </Show>
        <main
          id="control-ui-main"
          class={[
            "content",
            {
              "content--chat": view().chatLikeRoute,
              "content--workbench": view().workbenchRoute,
              "content--new-session": view().activeRoute === "new-session",
              "content--custodian": view().activeRoute === "custodian",
              "content--workboard": view().activeRoute === "workboard",
            },
          ]}
          ref={(element) => {
            content = element;
            props.host.contentElement = element;
            props.host.shellLayout.contentRef(element);
          }}
          tabindex={-1}
          onMouseDown={beginNativeWindowDragFromTopInset}
          inert={view().mobileNavLayout && view().navDrawerOpen}
        >
          <Show
            when={
              floatingSidebarAttentionVisible(view().floatingUpdateCard) ||
              (!view().floatingUpdateCard.compact && view().floatingUpdateCard.refreshRequired)
            }
          >
            <FloatingUpdateCard {...view().floatingUpdateCard} />
          </Show>
          <Show when={view().embedNavigation}>
            <LazySettingsSidebar host={props.host} sidebarProps={view().settingsSidebarProps} />
          </Show>
          <ShellLayoutProvider
            value={{
              get owner() {
                return props.host.shellLayout;
              },
              get host() {
                return content;
              },
            }}
          >
            <RouterOutlet
              ref={(element) => (props.host.routeOutlet = element)}
              inert={view().reloadRequired}
              aria-disabled={view().reloadRequired ? "true" : undefined}
              router={view().runtime.router}
              retryContext={view().context}
              retryEnabled={view().gatewayConnected}
              retentionScope={view().presentationScope}
              onNotFound={() => props.host.shellNavigation.recoverNotFoundRoute()}
              notFoundRecoveryReady={view().gatewayConnected}
            />
          </ShellLayoutProvider>
        </main>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {connectionAnnouncement()}
        </span>
        <ShellRequestedComponent
          host={props.host}
          component="terminal"
          revision={props.host.shellRevision()}
          label="terminal panel"
        >
          <TerminalPanel
            ref={(element) => {
              props.host.terminalPanel = element;
              props.host.shellComponentMounted(element);
            }}
            inert={view().navDrawerOpen}
            mobile={view().mobileNavLayout}
            client={view().gatewaySnapshot.client}
            gatewayConnected={view().gatewayConnected}
            available={view().terminalAvailable}
            agentId={view().selectedAgentId}
            sessionKey={view().sessionRoute ? props.host.activeSessionKey : null}
            suppressed={view().settingsTakeover || view().nativeEmbed}
            themeMode={view().context.theme.resolvedMode}
            basePath={view().context.basePath}
          />
        </ShellRequestedComponent>
        <Show when={!view().sessionRoute}>
          <ShellDocks
            host={props.host}
            elements={props.host.elements}
            context={view().context}
            revision={props.host.shellRevision()}
            navDrawerOpen={view().navDrawerOpen}
            suppressed={view().settingsTakeover || view().nativeEmbed}
            selectedAgentId={view().selectedAgentId}
            activeRoute={view().activeRoute}
          />
        </Show>
        <openclaw-assistant-panel
          ref={(element) => (props.host.elements.assistantPanel = element)}
          inert={view().navDrawerOpen}
          prop:custodianAvailable={view().custodianPanelAvailable && !view().nativeEmbed}
          prop:homeAvailable={view().homePanelAvailable && !view().nativeEmbed}
          prop:custodianSuppressed={view().activeRoute === "custodian"}
          prop:pageSessionKey={(props.host.shellRevision(), props.host.activeSessionKey)}
          prop:getPrimaryChatPane={view().callbacks.getPrimaryChatPane}
          prop:pageAgentId={view().selectedAgentId}
          prop:pageRouteId={view().activeRoute}
          prop:pageRouteFailed={
            (props.host.shellRevision(), props.host.routeState.routeFailed === true)
          }
          prop:minimizeRequestId={
            (props.host.shellRevision(), props.host.custodianMinimizeRequestId)
          }
        />
        <ShellRequestedComponent
          host={props.host}
          component="approvals"
          revision={props.host.shellRevision()}
          label={t("tabs.approvals")}
        >
          <ExecApproval
            ref={(element) => {
              props.host.elements.approvalOverlay = element;
              props.host.shellComponentMounted(element);
            }}
            props={{
              queue: view().overlaySnapshot.approvalQueue,
              busy: view().overlaySnapshot.approvalBusy,
              connected: view().gatewayConnected,
              canGrant: view().overlaySnapshot.approvalCanGrant,
              errors: view().overlaySnapshot.approvalErrors,
              nodeNames: view().overlaySnapshot.approvalNodeNames,
              sessions: sessionRows().read(),
              currentSessionKey: view().sessionRoute ? props.host.activeSessionKey : undefined,
              onDecision: (
                approvalId: string,
                decision: Parameters<
                  NonNullable<ShellViewHost["context"]>["overlays"]["decideApproval"]
                >[0],
              ) => view().context.overlays.decideApproval(decision, approvalId),
            }}
          />
        </ShellRequestedComponent>
        <DevicePairSetup
          props={{
            open: view().overlaySnapshot.devicePairSetupOpen,
            lifecycle: view().overlaySnapshot.devicePairSetupLifecycle,
            nowMs: view().nowMs,
            pendingCount: view().overlaySnapshot.devicePairPendingCount,
            onRefresh: () => view().context.overlays.refreshDevicePairSetup(),
            onAccessChange: (access) =>
              void view().context.overlays.setDevicePairSetupAccess(access),
            onClose: () => view().context.overlays.closeDevicePairSetup(),
            onManageDevices: () => {
              view().context.overlays.closeDevicePairSetup();
              props.host.shellNavigation.navigate("devices");
            },
            onGetApps: () => {
              view().context.overlays.closeDevicePairSetup();
              props.host.shellNavigation.navigate("apps");
            },
          }}
        />
        <Show when={view().memoryImportActive}>
          <ShellComponentBoundary label={t("onboarding.memoryImport.title")} showLoading>
            <OnboardingMemoryImport active={true} context={view().context} />
          </ShellComponentBoundary>
        </Show>
        <openclaw-toast-host ref={(element) => (props.host.toastElement = element)} />
      </div>
    </div>
  );
  return (
    <>
      <Show when={view()} keyed>
        {(_view) => {
          onSettled(() => props.host.commitRenderedPresentation());
          return null;
        }}
      </Show>
      <Show when={view().routeReady} fallback={<ConnectingSplash />}>
        <PluginSurface
          surface="workspace"
          enabled={view().workspacePluginsEnabled}
          props={{
            sessionKey: (props.host.shellRevision(), props.host.activeSessionKey),
            agentId: resolveUiSelectedSessionAgentId(
              {
                assistantAgentId:
                  view().context.agentSelection.state.selectedId ??
                  view().gatewaySnapshot.assistantAgentId,
                agentsList: view().context.agents.state.agentsList,
                hello: view().gatewaySnapshot.hello,
              },
              props.host.activeSessionKey,
            ),
            routeId: view().activeRoute,
          }}
          renderDefault={() => workspace}
        />
      </Show>
    </>
  );
}
