import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import wordmarkDarkText from "../assets/brand/openclaw-horizontal-dark-text.svg";
import wordmarkLightText from "../assets/brand/openclaw-horizontal-light-text.svg";
import type { GatewayStatus as GatewayStatusKind } from "../lib/gateway-status.ts";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import type { GatewayStatusProps } from "./gateway-status.ts";
import { GatewayStatus } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd, ShortcutText } from "./solid/kbd.tsx";
import { MobileHeaderNotice } from "./solid/mobile-header-notice.tsx";
import { MobileNavToggle } from "./solid/mobile-nav-toggle.tsx";
import "./tooltip.ts";

type Props = {
  navDrawerOpen: boolean;
  gatewayStatus?: GatewayStatusProps | null;
  newSessionAction: (() => JSX.Element) | undefined;
  resourceBasePath: string;
  environment: ControlUiEnvironment | null;
  onToggleDrawer: ((trigger: HTMLElement) => void) | undefined;
  onOpenPalette: (() => void) | undefined;
  /** Phone pages: title in the header, joined action pill, and the shared reconnect notice. */
  floating: boolean;
  navigationLocked?: boolean;
  /** A settings subpage: the menu button goes up a level instead. */
  onBack: (() => void) | undefined;
  pageTitle: string;
  registerPageActions: ((slot: HTMLElement) => () => void) | undefined;
};

/** Narrow-viewport header; the desktop sidebar owns navigation. */
defineSolidBridge<Props>(
  "openclaw-app-topbar",
  (props, host) => {
    host.style.display = "contents";
    const floatingNotice = () =>
      props.floating && props.gatewayStatus?.kind && props.gatewayStatus.kind !== "connected"
        ? props.gatewayStatus
        : undefined;
    return (
      <header
        class={[
          "topbar",
          {
            "topbar--floating": props.floating,
            // Nothing in the drawer or action pill works before the first connection.
            "topbar--navigation-locked": props.floating && props.navigationLocked,
          },
        ]}
      >
        <div class="topnav-shell">
          <Show
            when={props.floating && props.onBack}
            fallback={
              <openclaw-tooltip
                prop:content={props.navDrawerOpen ? t("nav.collapse") : t("nav.expand")}
              >
                <MobileNavToggle
                  class="topbar-nav-toggle"
                  open={props.navDrawerOpen}
                  status={props.floating ? undefined : props.gatewayStatus?.kind}
                  onToggle={(trigger) => props.onToggleDrawer?.(trigger)}
                />
              </openclaw-tooltip>
            }
          >
            <openclaw-tooltip prop:content={t("common.back")}>
              <button
                type="button"
                class="mobile-nav-toggle topbar-nav-toggle topbar-back"
                aria-label={t("common.back")}
                onClick={() => props.onBack?.()}
              >
                <Icon name="chevronLeft" />
              </button>
            </openclaw-tooltip>
          </Show>
          <div class="topnav-shell__content" onMouseDown={beginNativeWindowDrag}>
            <Show
              when={!props.floating}
              fallback={
                <>
                  <Show
                    when={props.navigationLocked}
                    fallback={
                      <Show when={props.pageTitle} keyed>
                        {(title) => <span class="topbar-page-title">{title}</span>}
                      </Show>
                    }
                  >
                    <span class="topbar-connection-brand">
                      <img
                        class="topbar-connection-brand__light"
                        src={wordmarkDarkText}
                        alt="OpenClaw"
                      />
                      <img
                        class="topbar-connection-brand__dark"
                        src={wordmarkLightText}
                        alt="OpenClaw"
                      />
                    </span>
                  </Show>
                </>
              }
            >
              <Show when={props.gatewayStatus?.kind && props.gatewayStatus.kind !== "connected"}>
                <div class="mobile-connection-status">
                  <GatewayStatus {...props.gatewayStatus!} />
                </div>
              </Show>
              <div class="topbar-brand" aria-label="OpenClaw">
                <img
                  class="topbar-brand__logo"
                  src={controlUiPublicAssetPath("apple-touch-icon.png", props.resourceBasePath)}
                  loading="lazy"
                  alt=""
                  aria-hidden="true"
                />
                <span class="topbar-brand__title">OpenClaw</span>
                <Show when={props.environment}>
                  {(environment) => (
                    <span class="control-ui-environment-pill">{environment().label}</span>
                  )}
                </Show>
              </div>
            </Show>
          </div>
          <div class="topnav-shell__actions">
            <Show when={props.floating}>
              <div
                ref={elementRef((slot: HTMLElement) => props.registerPageActions?.(slot))}
                class="topnav-shell__page-actions"
              />
            </Show>
            {props.newSessionAction?.()}
            <openclaw-tooltip prop:content={t("chat.commandPaletteTitle")}>
              <span slot="content">
                <ShortcutText
                  fallback={t("chat.openCommandPalette")}
                  text={t("chat.commandPaletteTitle").replace("⌘K", "{shortcut}")}
                  shortcut={() => <Kbd keys={["⌘", "K"]} inline />}
                />
              </span>
              <button
                class="topbar-search"
                onClick={() => props.onOpenPalette?.()}
                aria-label={t("chat.openCommandPalette")}
              >
                <Icon name="search" />
              </button>
            </openclaw-tooltip>
          </div>
        </div>
        {/* Chat's notice: it floats over the page below the header, and the title stays. */}
        <Show when={floatingNotice()}>
          {(status) => (
            <MobileHeaderNotice
              notice={{
                kind: "gateway",
                // SAFETY: floatingNotice filters out connected and empty statuses.
                status: status().kind as GatewayStatusKind,
                onRetry: status().onRetry,
              }}
            />
          )}
        </Show>
      </header>
    );
  },
  {
    properties: {
      navDrawerOpen: { default: false, attribute: false },
      gatewayStatus: { default: null, attribute: false },
      newSessionAction: { default: undefined, attribute: false },
      resourceBasePath: { default: "", attribute: false },
      environment: { default: null, attribute: false },
      onToggleDrawer: { default: undefined, attribute: false },
      onOpenPalette: { default: undefined, attribute: false },
      floating: { default: false, attribute: false },
      navigationLocked: { default: false, attribute: false },
      onBack: { default: undefined, attribute: false },
      pageTitle: { default: "", attribute: false },
      registerPageActions: { default: undefined, attribute: false },
    },
  },
);
