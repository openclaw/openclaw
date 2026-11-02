import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import type { GatewayStatusProps } from "./gateway-status.ts";
import { GatewayStatus } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd, ShortcutText } from "./solid/kbd.tsx";
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
};

/** Narrow-viewport header; the desktop sidebar owns navigation. */
defineSolidBridge<Props>(
  "openclaw-app-topbar",
  (props, host) => {
    host.style.display = "contents";
    return (
      <header class="topbar">
        <div class="topnav-shell">
          <openclaw-tooltip
            prop:content={props.navDrawerOpen ? t("nav.collapse") : t("nav.expand")}
          >
            <MobileNavToggle
              class="topbar-nav-toggle"
              open={props.navDrawerOpen}
              status={props.gatewayStatus?.kind}
              onToggle={(trigger) => props.onToggleDrawer?.(trigger)}
            />
          </openclaw-tooltip>
          <div class="topnav-shell__content" onMouseDown={beginNativeWindowDrag}>
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
          </div>
          <div class="topnav-shell__actions">
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
    },
  },
);
