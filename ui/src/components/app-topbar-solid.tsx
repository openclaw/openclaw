import { Show } from "solid-js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { LitContent } from "../lit/solid-content.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd, ShortcutText } from "./solid/kbd.tsx";
import "./tooltip.ts";

type Props = {
  navDrawerOpen: boolean;
  newSessionAction: unknown;
  resourceBasePath: string;
  environment: ControlUiEnvironment | null;
  onToggleDrawer: ((trigger: HTMLElement) => void) | undefined;
  onOpenPalette: (() => void) | undefined;
};

/** Narrow-viewport header; the desktop sidebar owns navigation. */
export const AppTopbar = defineSolidBridge<Props>(
  "openclaw-app-topbar",
  (props, host) => {
    host.style.display = "contents";
    const drawerLabel = () => (props.navDrawerOpen ? t("nav.collapse") : t("nav.expand"));
    return (
      <header class="topbar">
        <div class="topnav-shell">
          <openclaw-tooltip prop:content={drawerLabel()}>
            <button
              type="button"
              class="topbar-icon-btn topbar-nav-toggle"
              onClick={(event) => props.onToggleDrawer?.(event.currentTarget)}
              aria-label={drawerLabel()}
              aria-expanded={props.navDrawerOpen ? "true" : "false"}
            >
              <span class="nav-collapse-toggle__icon" aria-hidden="true">
                <Icon name="menu" />
              </span>
            </button>
          </openclaw-tooltip>
          <div class="topnav-shell__content" onMouseDown={beginNativeWindowDrag}>
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
            <LitContent value={props.newSessionAction} />
            <openclaw-tooltip prop:content={t("chat.commandPaletteTitle")}>
              <span slot="content">
                <ShortcutText
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
      newSessionAction: { default: undefined, attribute: false },
      resourceBasePath: { default: "", attribute: false },
      environment: { default: null, attribute: false },
      onToggleDrawer: { default: undefined, attribute: false },
      onOpenPalette: { default: undefined, attribute: false },
    },
  },
);
