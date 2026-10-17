import "../lib/toast-host.ts";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { LazySettingsSidebar } from "../components/settings-sidebar-lazy.tsx";
import { renderGatewayStatus } from "../components/solid/gateway-status.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { ConnectingSplash } from "../components/solid/loading-skeleton.tsx";
import {
  ContextNewSessionAction,
  renderNewSessionLink as NewSessionLink,
} from "../components/solid/new-session-link.tsx";
import type { ThemeModeChangeDetail } from "../components/theme-mode-toggle.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { resolveUiSelectedSessionAgentId } from "../lib/sessions/session-key.ts";
import { PluginSurface } from "../plugins/control-ui-view.solid.tsx";
import { DevicePairSetup } from "./app-shell-device-pair-setup.tsx";
import { ShellDocks } from "./app-shell-docks.tsx";
import {
  ShellLazyOverlays,
  type ShellElementAttributes,
  type ShellOwnedElements,
} from "./app-shell-lazy-view.tsx";
import { readShellView, type ShellViewHost } from "./app-shell-view-state.ts";
import {
  isOptionalElementDefined,
  MACOS_TITLEBAR_ELEMENT,
  SIDEBAR_ATTENTION_ELEMENT,
} from "./lazy-custom-element.ts";
import { beginNativeWindowDrag, beginNativeWindowDragFromTopInset } from "./native-window-drag.ts";
import { FloatingUpdateCard } from "./navigation-surface-view.tsx";
import { floatingSidebarAttentionVisible } from "./navigation-surface.ts";
import { RouterOutlet } from "./router-outlet.tsx";
import { NAV_WIDTH_MAX, NAV_WIDTH_MIN } from "./settings.ts";
import { CollapsedHomeToggle } from "./shell-assistant-toggles.tsx";
import { ShellLayoutProvider } from "./shell-layout-traits-solid.tsx";

export type { ShellViewHost } from "./app-shell-view-state.ts";

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

export function ApplicationShell(props: { host: ShellViewHost }): SolidJSX.Element {
  let content!: HTMLElement;
  const [navResizing, setNavResizing] = createSignal(false);
  const view = createMemo(() => {
    props.host.shellRevision();
    return readShellView(props.host);
  });
  const shellConnectionStatus = createMemo(() => view().shellConnectionStatus);
  // Legacy Mac hosts stamp this immutable host class before mounting the shell.
  // The web-chrome flag remains a reactive view read for the current host path.
  const legacyMacChrome = () =>
    !view().nativeWebChrome && document.documentElement.classList.contains("openclaw-native-macos");
  // Lazy registrations and the native sidebar consume committed shell presentation.
  createEffect(view, (state) => {
    props.host.lazyCustomElements.requestWhileActive(
      props.host.onboardingMemoryImportElement,
      state.memoryImportActive,
    );
    if (state.nativeWebChrome && !state.onboarding) {
      props.host.lazyCustomElements.preload(MACOS_TITLEBAR_ELEMENT, { reportError: true });
    }
    if (!state.nativeEmbed && (state.onboarding || state.floatingAttentionVisible)) {
      props.host.lazyCustomElements.preload(SIDEBAR_ATTENTION_ELEMENT, { reportError: true });
    }
    if (!state.settingsTakeover && !state.nativeEmbed) {
      Object.assign(props.host.navigationSidebar, state.sidebarProperties);
    }
  });
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
            "shell--connection-status": Boolean(view().shellConnectionStatus),
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
        onTheme-change={(event: CustomEvent<ThemeModeChangeDetail>) =>
          props.host.handleThemeChange(event)
        }
      >
        <a class="shell-skip-link" href="#control-ui-main" inert={view().navDrawerOpen}>
          {t("common.skipToMainContent")}
        </a>
        <Show when={view().nativeWebChrome && !view().onboarding}>
          <openclaw-macos-titlebar-controls
            inert={view().navDrawerOpen}
            prop:historyOnly={view().settingsTakeover}
            prop:canGoBack={props.host.nativeHistoryState().canGoBack}
            prop:canGoForward={props.host.nativeHistoryState().canGoForward}
          />
        </Show>
        <Show when={!view().nativeEmbed}>
          <openclaw-app-topbar
            inert={view().navDrawerOpen}
            prop:resourceBasePath={view().context.resourceBasePath}
            prop:environment={view().config.environment}
            prop:navDrawerOpen={view().navDrawerOpen}
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
              <openclaw-tooltip
                prop:content={`${t("nav.expand")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`}
              >
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
                  <Icon name="panelLeftOpen" />
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
              <openclaw-tooltip
                prop:content={`${t("chat.openCommandPalette")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette)})`}
              >
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
            class="shell-nav-backdrop"
            tabindex={-1}
            aria-hidden="true"
            inert={!view().navDrawerOpen}
            onClick={() => props.host.closeNavDrawer({ restoreFocus: true })}
          />
          <div
            ref={(element) => (props.host.navDrawerElement = element)}
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
            <Show when={view().settingsTakeover} fallback={props.host.navigationSidebar}>
              <LazySettingsSidebar
                loader={props.host.settingsSidebar}
                sidebarProps={view().settingsSidebarProps}
              />
            </Show>
          </div>
        </Show>
        <Show
          when={
            !view().nativeEmbed &&
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
            title={t("nav.resize")}
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
              "content--actions-blocked": view().pageActionsBlocked,
            },
          ]}
          ref={(element) => {
            content = element;
            props.host.contentElement = element;
            props.host.shellLayout.contentRef(element);
          }}
          tabindex={-1}
          onMouseDown={beginNativeWindowDragFromTopInset}
          inert={
            (!view().nativeEmbed && view().pageActionsBlocked) ||
            (view().mobileNavLayout && view().navDrawerOpen)
          }
        >
          <Show when={view().pageActionsBlocked}>
            <div class="connection-action-block" role="status" aria-live="polite">
              <span class="connection-action-block__icon" aria-hidden="true">
                <Icon name="globeOff" />
              </span>
              <span class="connection-action-block__text">
                {t(
                  view().settingsTakeover
                    ? "connection.settingsChangesUnavailable"
                    : "connection.actionsUnavailable",
                )}
              </span>
            </div>
          </Show>
          <Show
            when={
              floatingSidebarAttentionVisible(view().floatingUpdateCard) ||
              (!view().floatingUpdateCard.compact && view().floatingUpdateCard.refreshRequired)
            }
          >
            <FloatingUpdateCard {...view().floatingUpdateCard} />
          </Show>
          <Show when={view().embedNavigation}>
            <LazySettingsSidebar
              loader={props.host.settingsSidebar}
              sidebarProps={view().settingsSidebarProps}
            />
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
              inert={view().pageActionsBlocked || view().reloadRequired}
              aria-disabled={
                view().pageActionsBlocked || view().reloadRequired ? "true" : undefined
              }
              router={view().runtime.router}
              retryContext={view().context}
              retryEnabled={view().gatewayConnected}
              retentionScope={view().presentationScope}
              onNotFound={props.host.recoverNotFoundRoute}
              notFoundRecoveryReady={view().gatewayConnected}
            />
          </ShellLayoutProvider>
        </main>
        <Show when={shellConnectionStatus()}>
          <div class="shell-connection-status">
            {renderGatewayStatus({
              kind: shellConnectionStatus()!,
              get lastError() {
                return view().gatewaySnapshot.lastError;
              },
              onRetry: props.host.viewCallbacks.retryGateway,
            })}
          </div>
        </Show>
        <openclaw-terminal-panel
          ref={(element) => (props.host.terminalPanel = element)}
          inert={view().navDrawerOpen}
          prop:client={view().gatewayConnected ? view().gatewaySnapshot.client : null}
          prop:available={view().terminalAvailable}
          prop:agentId={view().selectedAgentId}
          prop:sessionKey={view().sessionRoute ? props.host.activeSessionKey : null}
          prop:suppressed={view().settingsTakeover || view().nativeEmbed}
          prop:themeMode={view().context.theme.resolvedMode}
          prop:basePath={view().context.basePath}
        />
        <Show when={!view().sessionRoute}>
          <ShellDocks
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
          prop:pageAgentId={view().selectedAgentId}
          prop:pageRouteId={view().activeRoute}
          prop:pageRouteFailed={
            (props.host.shellRevision(), props.host.routeState.routeFailed === true)
          }
          prop:minimizeRequestId={
            (props.host.shellRevision(), props.host.custodianMinimizeRequestId)
          }
        />
        <Show
          when={
            (props.host.shellRevision(), isOptionalElementDefined(props.host.execApprovalElement))
          }
        >
          <openclaw-exec-approval
            ref={(element) => (props.host.elements.approvalOverlay = element)}
            prop:props={{
              queue: view().overlaySnapshot.approvalQueue,
              busy: view().overlaySnapshot.approvalBusy,
              canGrant: view().overlaySnapshot.approvalCanGrant,
              errors: view().overlaySnapshot.approvalErrors,
              onDecision: (
                approvalId: string,
                decision: Parameters<
                  NonNullable<ShellViewHost["context"]>["overlays"]["decideApproval"]
                >[0],
              ) => view().context.overlays.decideApproval(decision, approvalId),
            }}
          />
        </Show>
        <DevicePairSetup
          loader={props.host.devicePairSetup}
          props={{
            open: view().overlaySnapshot.devicePairSetupOpen,
            lifecycle: view().overlaySnapshot.devicePairSetupLifecycle,
            nowMs: view().nowMs,
            pendingCount: view().overlaySnapshot.devicePairPendingCount,
            onRefresh: () => void view().context.overlays.refreshDevicePairSetup(),
            onAccessChange: (access) =>
              void view().context.overlays.setDevicePairSetupAccess(access),
            onClose: () => view().context.overlays.closeDevicePairSetup(),
            onManageDevices: () => {
              view().context.overlays.closeDevicePairSetup();
              props.host.navigate("devices");
            },
            onGetApps: () => {
              view().context.overlays.closeDevicePairSetup();
              props.host.navigate("apps");
            },
          }}
        />
        <Show
          when={
            view().memoryImportActive &&
            (props.host.shellRevision(),
            isOptionalElementDefined(props.host.onboardingMemoryImportElement))
          }
        >
          <openclaw-onboarding-memory-import prop:active={true} prop:context={view().context} />
        </Show>
        <openclaw-toast-host ref={(element) => (props.host.toastElement = element)} />
      </div>
    </div>
  );
  return (
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
  );
}
