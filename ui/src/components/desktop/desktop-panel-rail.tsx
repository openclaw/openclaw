import type { WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { Show, createEffect, createMemo, createSignal, createUniqueId, onSettled } from "solid-js";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { Menu, type MenuEntry, type MenuItem } from "../solid/menu.tsx";
import type { DesktopSizingMode } from "./desktop-client.ts";
import { DesktopIcon } from "./desktop-icon.tsx";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import "../../styles/session-panel-rail.css";

registerEnglishCatalog(registerDesktopEnglish);

export type DesktopConnectionControls = {
  state: DesktopPanelState;
  controlling: boolean;
  desktopApps: WorkerDesktopAppId[];
  launchingApp: WorkerDesktopAppId | null;
  showApps: boolean;
  sizing: DesktopSizingOptions;
  onDisconnect: () => void;
  onLaunch: (app: WorkerDesktopAppId) => void;
  onTakeControl: () => void;
  onControlToggle: () => void;
};

export type DesktopConnectionRailOptions = {
  platform: "desktop" | "mobile";
  machine: { name: string; host: boolean } | null;
  fullscreen: boolean;
  fullscreenSupported: boolean;
  expanded: boolean;
  pendingLabel: string;
  controlTransition: boolean;
  takeoverText: string | null;
  failureKind: "error" | "lost" | "closed" | null;
  onToggleExpanded?: () => void;
  onFullscreen: (button: HTMLButtonElement) => void;
  onOpenWindow?: () => void;
  openWindowHref?: string;
  audioControl: () => JSX.Element;
  pictureInPictureControl: () => JSX.Element;
};

export function DesktopOpenWindow(props: { href: string; inline?: boolean }) {
  const link = () => (
    <a
      class="session-panel-rail__button desktop-open-window"
      href={props.href}
      target="_blank"
      rel="noopener"
      title={t("desktop.openWindow")}
      aria-label={t("desktop.openWindow")}
    >
      <Icon name="externalLink" />
    </a>
  );
  return (
    <Show when={props.inline} fallback={<div class="session-panel-rail__group">{link()}</div>}>
      {link()}
    </Show>
  );
}

/** Presentation only: every action delegates to the existing desktop or shell owner. */
export function DesktopConnectionRail(
  props: DesktopConnectionControls & { options: DesktopConnectionRailOptions; recovery?: boolean },
) {
  const id = createUniqueId();
  const mobile = createMemo(() => props.options.platform === "mobile");
  const sizingMenu = createDesktopSizingMenu(() => ({
    ...props.sizing,
    icons: !mobile(),
  }));
  let rail!: HTMLDivElement;
  let inlineWindow!: HTMLDivElement;
  const [windowInOverflow, setWindowInOverflow] = createSignal(false);
  createEffect(
    () => !props.recovery || mobile(),
    (hasTools) => {
      // Recovery has identity and a local retry; observe only mounted viewer tools.
      if (!hasTools) {
        return undefined;
      }
      // Read the CSS-selected presentation so hidden groups leave Menu's item graph.
      const measure = () => {
        setWindowInOverflow(getComputedStyle(inlineWindow).display === "none");
      };
      const observer = new ResizeObserver(measure);
      observer.observe(rail);
      measure();
      return () => observer.disconnect();
    },
  );
  const fullscreenControl = () => (
    <button
      type="button"
      class="desktop-toolbar-action"
      title={t(props.options.fullscreen ? "desktop.exitFullscreen" : "desktop.enterFullscreen")}
      aria-label={t(
        props.options.fullscreen ? "desktop.exitFullscreen" : "desktop.enterFullscreen",
      )}
      disabled={!props.options.fullscreenSupported}
      onClick={(event) => props.options.onFullscreen(event.currentTarget)}
    >
      {mobile() ? (
        <Icon name={props.options.fullscreen ? "minimize" : "maximize"} />
      ) : (
        <DesktopIcon name={props.options.fullscreen ? "exit-fullscreen" : "fullscreen"} />
      )}
      <span class="desktop-rail__action-label">
        {t(props.options.fullscreen ? "desktop.exitFullscreen" : "desktop.enterFullscreen")}
      </span>
    </button>
  );
  const expandControl = () =>
    !mobile() &&
    !props.options.fullscreen &&
    props.options.onToggleExpanded && (
      <button
        type="button"
        class="desktop-toolbar-action"
        title={t(props.options.expanded ? "desktop.collapsePanel" : "desktop.expandPanel")}
        aria-label={t(props.options.expanded ? "desktop.collapsePanel" : "desktop.expandPanel")}
        onClick={() => props.options.onToggleExpanded?.()}
      >
        <Icon name={props.options.expanded ? "sessionPanelRestore" : "sessionPanelExpand"} />
        <span class="desktop-rail__action-label">
          {t(props.options.expanded ? "desktop.collapsePanel" : "desktop.expandPanel")}
        </span>
      </button>
    );
  const menuItems = (): MenuEntry[] => {
    const overflow: MenuEntry[] = [
      {
        kind: "group",
        id: "tools",
        class: mobile() ? "desktop-rail__overflow-tools" : undefined,
        items: [
          {
            kind: "content",
            id: "media",
            content: (
              <>
                {props.options.audioControl()}
                {props.options.pictureInPictureControl()}
              </>
            ),
          },
        ],
      },
      ...(!mobile()
        ? [
            {
              kind: "group" as const,
              id: "sizing",
              class: "desktop-rail__menu-section",
              items: sizingMenu.items(),
            },
          ]
        : []),
    ];
    if (windowInOverflow()) {
      overflow.push({
        kind: "content",
        id: "window",
        content: (
          <div class="desktop-rail__overflow-window">
            {expandControl()}
            {fullscreenControl()}
          </div>
        ),
      });
    }
    return [
      ...overflow,
      ...(props.showApps
        ? props.desktopApps.map((app) => ({
            id: app,
            label: t(app === "browser" ? "browser.title" : "terminal.title"),
            icon: (
              <Icon
                name={app === "browser" ? (mobile() ? "chrome" : "externalLink") : "terminal"}
              />
            ),
            disabled: props.state !== "connected" || props.launchingApp === app,
          }))
        : []),
      ...(mobile() && props.options.openWindowHref
        ? [
            {
              id: "open-window-link",
              label: t("desktop.openWindow"),
              href: props.options.openWindowHref,
              attributes: { target: "_blank", rel: "noopener" },
              icon: <Icon name="externalLink" />,
            },
          ]
        : props.options.onOpenWindow
          ? [
              {
                id: "open-window",
                label: t("desktop.openWindow"),
                icon: <Icon name="externalLink" />,
              },
            ]
          : []),
      {
        id: "disconnect",
        label: t("desktop.disconnect"),
        icon: mobile() ? <Icon name="x" /> : <DesktopIcon name="disconnect" />,
        class: mobile() ? undefined : "desktop-rail__disconnect",
        disabled: props.state === "disconnected" || props.state === "inventory-error",
      },
    ];
  };
  return (
    <div
      ref={(node) => {
        rail = node;
      }}
      class={[
        "desktop-connection-rail",
        { "desktop-connection-rail--mobile": mobile(), "session-panel-rail": !mobile() },
      ]}
      data-presentation={mobile() ? undefined : "desktop"}
    >
      {!mobile() && props.options.fullscreen && props.options.takeoverText && (
        <div class="desktop-takeover desktop-takeover--fullscreen" role="status">
          {props.options.takeoverText}
        </div>
      )}
      <div class="desktop-rail__identity">
        <span
          class={[
            "desktop-rail__dot",
            {
              "is-connected": props.state === "connected",
              "is-disconnected":
                props.state === "disconnected" &&
                (props.options.failureKind === "lost" ||
                  (!mobile() && props.options.failureKind === "closed")),
            },
          ]}
          role="img"
          aria-label={t(
            props.state === "connected"
              ? "desktop.connected"
              : props.state === "connecting"
                ? "desktop.connecting"
                : "desktop.disconnectedClean",
          )}
        />
        <div class="desktop-rail__machine">
          <DesktopMachineName name={props.options.machine?.name ?? ""} />
          {mobile() ? (
            <span class="desktop-rail__host">
              {t(
                props.state === "connected"
                  ? props.controlling
                    ? "desktop.controlling"
                    : "desktop.viewOnly"
                  : props.state === "connecting"
                    ? "desktop.connecting"
                    : "desktop.disconnectedClean",
              )}
            </span>
          ) : (
            props.options.machine?.host && (
              <span class="desktop-rail__host">{t("desktop.gatewayHost")}</span>
            )
          )}
        </div>
      </div>
      <Show
        when={!props.recovery || mobile()}
        fallback={
          <div class="desktop-rail__actions">
            {props.options.fullscreen && fullscreenControl()}
            {props.options.openWindowHref && (
              <DesktopOpenWindow href={props.options.openWindowHref} />
            )}
          </div>
        }
      >
        <div class="desktop-rail__actions">
          <div class="desktop-rail__pill">
            <button
              type="button"
              class="desktop-toolbar-action desktop-rail__control"
              disabled={props.state !== "connected"}
              onClick={() => (props.controlling ? props.onControlToggle() : props.onTakeControl())}
            >
              {!mobile() &&
                (props.controlling ? (
                  <Icon name="eye" />
                ) : (
                  <svg
                    class="desktop-rail__cursor"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m4 3 7 18 2-8 8-2Z" />
                  </svg>
                ))}
              {t(
                props.controlling
                  ? mobile()
                    ? "desktop.viewOnly"
                    : "desktop.backToViewing"
                  : "desktop.takeControl",
              )}
            </button>
          </div>
          {mobile() && (
            <div class="desktop-rail__pill desktop-rail__tools">
              <DesktopSizing
                {...props.sizing}
                presentation="menu"
                placement={props.options.fullscreen ? "top-end" : "bottom-end"}
              />
            </div>
          )}
          <Menu
            id={`desktop-actions-${id}`}
            class={mobile() ? undefined : "desktop-rail__pill"}
            label={t("desktop.moreActions")}
            trigger={<Icon name="moreHorizontal" />}
            triggerClass="desktop-toolbar-action desktop-rail__more"
            panelClass={["desktop-rail__menu", { "desktop-rail__menu--desktop": !mobile() }]}
            placement={props.options.fullscreen ? "top-end" : "bottom-end"}
            items={menuItems()}
            onSelect={(item) => {
              if (sizingMenu.select(item)) {
                return;
              }
              if (item.id === "disconnect") {
                props.onDisconnect();
              } else if (item.id === "open-window") {
                props.options.onOpenWindow?.();
              } else {
                const app = props.desktopApps.find((candidate) => candidate === item.id);
                if (app && props.state === "connected") {
                  props.onLaunch(app);
                }
              }
            }}
          />
          <Show
            when={mobile()}
            fallback={
              <div class="desktop-rail__pill desktop-rail__window-group">
                <div
                  ref={(node) => {
                    inlineWindow = node;
                  }}
                  class="desktop-rail__window"
                >
                  {expandControl()}
                  {fullscreenControl()}
                </div>
                {props.options.openWindowHref && (
                  <DesktopOpenWindow href={props.options.openWindowHref} inline />
                )}
              </div>
            }
          >
            <div
              ref={(node) => {
                inlineWindow = node;
              }}
              class="desktop-rail__pill desktop-rail__window"
            >
              {expandControl()}
              {fullscreenControl()}
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function DesktopMachineName(props: { name: string }) {
  let element!: HTMLSpanElement;
  const [overflow, setOverflow] = createSignal(false);
  const measure = () => setOverflow(element.scrollWidth > element.clientWidth);
  createEffect(
    () => props.name,
    () => {
      if (element) {
        measure();
      }
    },
  );
  onSettled(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  });
  return (
    <span
      ref={(node) => {
        element = node;
      }}
      class={["desktop-rail__name", { "is-overflowing": overflow() }]}
      title={props.name}
    >
      {props.name}
    </span>
  );
}

export type DesktopSizingOptions = {
  mode: DesktopSizingMode;
  canResize: boolean;
  onChange: (mode: DesktopSizingMode) => void;
};

type DesktopSizingMenuMode = {
  mode: Exclude<DesktopSizingMode, "match">;
  label: string;
};

/** Both menu placements consume the same modes and dispatch to the sizing owner. */
function createDesktopSizingMenu(
  readOptions: () => DesktopSizingOptions & {
    additionalModes?: readonly DesktopSizingMenuMode[];
    icons?: boolean;
  },
) {
  const modes = () => {
    const options = readOptions();
    return [
      { mode: "fit" as const, label: t("desktop.fit") },
      { mode: "actual" as const, label: t("desktop.actualSizeLabel") },
      ...(options.additionalModes ?? []),
      ...(options.canResize || options.mode === "match"
        ? [{ mode: "match" as const, label: t("desktop.match") }]
        : []),
    ];
  };
  return {
    label: () =>
      modes().find((entry) => entry.mode === readOptions().mode)?.label ?? t("desktop.sizing"),
    items: (): MenuItem[] =>
      modes().map((entry) => ({
        id: `sizing-${entry.mode}`,
        label: entry.label,
        icon: readOptions().icons ? <DesktopIcon name={entry.mode} /> : undefined,
        type: "radio",
        checked: readOptions().mode === entry.mode,
        disabled: entry.mode === "match" && !readOptions().canResize,
        attributes: entry.mode === "match" ? { title: t("desktop.matchRequirement") } : undefined,
      })),
    select(item: MenuItem): boolean {
      const entry = modes().find((candidate) => `sizing-${candidate.mode}` === item.id);
      if (!entry) {
        return false;
      }
      const options = readOptions();
      if (entry.mode !== "match" || options.canResize) {
        options.onChange(entry.mode);
      }
      return true;
    },
  };
}

export function DesktopSizing(
  props: DesktopSizingOptions & {
    presentation?: "menu";
    placement?: "bottom-end" | "top-end";
    /** Extra client-supported modes; Match eligibility remains owned below. */
    additionalModes?: readonly DesktopSizingMenuMode[];
  },
) {
  const id = createUniqueId();
  const sizingMenu = createDesktopSizingMenu(() => props);
  // Retain Match during reconnect so Fit can cancel it before authentication completes.
  return (
    <Show
      when={props.presentation === "menu"}
      fallback={
        <select
          class="desktop-sizing"
          aria-label={t("desktop.sizing")}
          title={t("desktop.matchRequirement")}
          onChange={(event) => {
            const mode = event.currentTarget.value;
            if (mode === "fit" || mode === "actual" || (mode === "match" && props.canResize)) {
              props.onChange(mode);
            }
          }}
        >
          <option value="fit" selected={props.mode === "fit"}>
            {t("desktop.fit")}
          </option>
          <option value="actual" selected={props.mode === "actual"}>
            {t("desktop.actual")}
          </option>
          {(props.canResize || props.mode === "match") && (
            <option value="match" selected={props.mode === "match"} disabled={!props.canResize}>
              {t("desktop.match")}
            </option>
          )}
        </select>
      }
    >
      <Menu
        id={`desktop-sizing-${id}`}
        label={t("desktop.sizing")}
        class="desktop-sizing-menu"
        triggerClass="desktop-toolbar-action desktop-sizing-menu__trigger"
        placement={props.placement ?? "bottom-end"}
        trigger={
          <span class="desktop-sizing-menu__value">
            <Icon name="maximize" class="desktop-sizing-menu__icon" />
            {sizingMenu.label()}
            <Icon name="chevronDown" />
          </span>
        }
        items={sizingMenu.items()}
        onSelect={(item) => sizingMenu.select(item)}
      />
    </Show>
  );
}
