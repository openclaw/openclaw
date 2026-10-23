import { children, Errored, For, isPending, lazy, Loading, Show } from "solid-js";
import { titleForRoute, visibleSettingsNavigationGroups } from "../app-navigation.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { SettingsSidebarProps } from "./settings-sidebar.tsx";
import { GatewayStatus } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";

type SettingsSidebarModule = typeof import("./settings-sidebar-shell.tsx");
const SettingsSidebar = lazy(() => import("./settings-sidebar-shell.tsx"), {
  export: "ShellSettingsSidebar",
});
export type SettingsSidebarFallbackProps = Pick<
  SettingsSidebarProps,
  | "presentation"
  | "activeRouteId"
  | "connectionStatus"
  | "footerStatus"
  | "onExit"
  | "nativeDeviceSettings"
> & { canAdmin: boolean };

export function LazySettingsSidebar(
  props: Parameters<SettingsSidebarModule["ShellSettingsSidebar"]>[0],
) {
  // Observe the lazy content while Errored retains its fallback during a retry.
  const content = children(() => (
    <SettingsSidebar host={props.host} sidebarProps={props.sidebarProps} />
  ));
  return (
    <Errored
      fallback={(_error, reset) => (
        <SettingsSidebarFallback
          sidebarProps={props.sidebarProps}
          failed={!isPending(() => content())}
          retry={reset}
        />
      )}
    >
      <Loading
        fallback={<SettingsSidebarFallback sidebarProps={props.sidebarProps} failed={false} />}
      >
        {content()}
      </Loading>
    </Errored>
  );
}

function SettingsSidebarFallback(props: {
  sidebarProps: SettingsSidebarFallbackProps;
  failed: boolean;
  retry?: () => void;
}) {
  return (
    <>
      <Show
        when={
          props.sidebarProps.presentation !== "embed-list" &&
          props.sidebarProps.presentation !== "embed-page"
        }
        fallback={
          <section
            class={
              props.sidebarProps.presentation === "embed-list"
                ? "settings-embed-list"
                : "native-embed-header"
            }
            aria-busy={props.failed ? "false" : "true"}
          >
            <Show when={props.sidebarProps.presentation === "embed-page"}>
              <button
                class="native-embed-header__back btn btn--ghost"
                type="button"
                onClick={() => props.sidebarProps.onExit()}
              >
                {t("common.back")}
              </button>
            </Show>
            <h1 class="page-title">
              {props.sidebarProps.presentation === "embed-list"
                ? t("nav.settings")
                : titleForRoute(props.sidebarProps.activeRouteId, t)}
            </h1>
            <p role={props.failed ? "alert" : "status"}>
              {t(props.failed ? "nav.settingsLoadFailed" : "common.loading")}
            </p>
            <Show when={props.failed}>
              <button class="btn" onClick={() => props.retry?.()}>
                {t("common.retry")}
              </button>
            </Show>
          </section>
        }
      >
        <aside class="settings-sidebar" aria-busy={props.failed ? undefined : "true"}>
          <header class="settings-sidebar__header" onMouseDown={beginNativeWindowDragFromTopInset}>
            <button
              type="button"
              class="settings-sidebar__back"
              onClick={() => props.sidebarProps.onExit()}
            >
              <span class="settings-sidebar__back-icon" aria-hidden="true">
                <Icon name="arrowLeft" />
              </span>
              {t("nav.exitSettings")}
            </button>
            <h1 class="settings-sidebar__title">{t("nav.settings")}</h1>
          </header>
          <Show when={props.failed} fallback={<SettingsSidebarSkeleton {...props.sidebarProps} />}>
            <div class="settings-sidebar__empty" role="alert">
              {t("nav.settingsLoadFailed")}
              <button class="btn btn--sm" type="button" onClick={() => props.retry?.()}>
                {t("common.retry")}
              </button>
            </div>
          </Show>
        </aside>
      </Show>
      <Show when={props.sidebarProps.presentation === "sidebar" && props.sidebarProps.footerStatus}>
        {(status) => (
          <aside class="sidebar">
            <div class="sidebar-shell">
              <div class="sidebar-shell__content" />
              <div class="sidebar-shell__footer">
                <GatewayStatus {...status()} row />
              </div>
            </div>
          </aside>
        )}
      </Show>
    </>
  );
}

function SettingsSidebarSkeleton(props: SettingsSidebarFallbackProps) {
  const groups = () =>
    visibleSettingsNavigationGroups(props.canAdmin, props.nativeDeviceSettings ?? null);
  return (
    <>
      <div class="settings-sidebar__agent" aria-hidden="true">
        <span class="skeleton settings-sidebar__loading-agent" />
      </div>
      <div class="settings-sidebar__search" aria-hidden="true">
        <span class="skeleton settings-sidebar__loading-search" />
      </div>
      <div
        class="settings-sidebar__nav settings-loading-skeleton settings-sidebar__loading"
        role="status"
        aria-busy="true"
        aria-label={t("common.loading")}
      >
        <For each={groups()}>
          {(group) => (
            <div class="settings-sidebar__group" aria-hidden="true">
              <Show when={group.labelKey}>
                <span class="skeleton settings-sidebar__loading-group-label" />
              </Show>
              <For each={group.routes}>
                {() => (
                  <span class="settings-sidebar__item settings-sidebar__loading-item">
                    <span class="skeleton settings-sidebar__loading-icon" />
                    <span class="skeleton settings-sidebar__loading-label" />
                  </span>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </>
  );
}
