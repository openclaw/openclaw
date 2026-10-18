import { For, onSettled, Show } from "solid-js";
import { titleForRoute, visibleSettingsNavigationGroups } from "../app-navigation.ts";
import type { LazyRenderer } from "../app/lazy-renderer.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { SettingsSidebarProps } from "./settings-sidebar.tsx";
import { Icon } from "./solid/icon.tsx";

type SettingsSidebarModule = typeof import("./settings-sidebar-shell.tsx");
export type SettingsSidebarLoader = LazyRenderer<SettingsSidebarModule["ShellSettingsSidebar"]>;
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
  props: Parameters<SettingsSidebarModule["ShellSettingsSidebar"]>[0] & {
    loader: SettingsSidebarLoader;
  },
) {
  onSettled(() => {
    if (!props.loader.renderer() && !props.loader.failed()) {
      props.loader.load();
    }
  });
  return (
    <Show
      when={props.loader.renderer()}
      keyed
      fallback={
        <SettingsSidebarFallback
          sidebarProps={props.sidebarProps}
          failed={props.loader.failed()}
          retry={() => props.loader.retry()}
        />
      }
    >
      {(View) => <View host={props.host} sidebarProps={props.sidebarProps} />}
    </Show>
  );
}

function SettingsSidebarFallback(props: {
  sidebarProps: SettingsSidebarFallbackProps;
  failed: boolean;
  retry: () => void;
}) {
  return (
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
            <button class="btn" onClick={() => props.retry()}>
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
            <button class="btn btn--sm" type="button" onClick={() => props.retry()}>
              {t("common.retry")}
            </button>
          </div>
        </Show>
      </aside>
    </Show>
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
