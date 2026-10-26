import { createMemo, Errored, For, Loading, onSettled, Show } from "solid-js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import {
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  pathForRoute,
} from "../../app-route-paths.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { createPluginDiscovery } from "../plugins/plugin-discovery.ts";
import type { ConfigProps } from "./view-types.ts";

export function AppearanceLobsterPacks(
  props: Pick<ConfigProps, "lobsterdexHref" | "onOpenLobsterdex">,
) {
  const application = useApplication();
  const branding = projectOwner(application.theme, (theme) => theme.branding);
  const listeners = createChangeListeners();
  let active = true;
  const publish = () => {
    if (active) {
      listeners.publish();
    }
  };
  const gateway = new GatewayPageBinding(publish, {
    getGateway: () => application.gateway,
    invalidateRequests: () => discovery.invalidate(),
    ensureInitialData: () => void discovery.refresh(),
  });
  const discovery = createPluginDiscovery(
    { getClient: () => gateway.client, isConnected: () => gateway.connected },
    publish,
    { category: "lobster-packs" },
  );
  const state = projectOwner({ subscribe: listeners.subscribe }, () => discovery.read());
  const ready = createMemo(
    () =>
      state.read().reads.browse?.then(() => {
        const error = discovery.read().error;
        if (error) {
          throw new Error(error);
        }
        return null;
      }) ?? null,
  );
  const more = createMemo(() => state.read().reads.more?.then(() => null) ?? null);
  const href = (item: NonNullable<ReturnType<typeof discovery.read>["result"]>["items"][number]) =>
    item.local.installed && item.local.pluginId
      ? pathForPluginSettings(item.local.pluginId, application.basePath)
      : pathForPluginCatalogEntry(item.id, application.basePath);
  const navigate = (event: MouseEvent, route: "plugins" | "plugin-settings", pathname: string) =>
    handleNavigationClick(event, () =>
      application.navigate(route, { pathname, search: "", hash: "" }),
    );
  const connected = () => {
    state.read();
    return gateway.connected;
  };
  onSettled(() => {
    gateway.connect();
    const stop = application.gateway.subscribeEvents((event) => {
      if (event.event === "plugins.changed" && gateway.connected) {
        void discovery.refresh();
      }
    });
    return () => {
      active = false;
      stop();
      gateway.dispose();
    };
  });
  return (
    <div class="settings-theme-discovery__panel settings-appearance-packs">
      <h3>{t("configView.appearance.lobsterPacks")}</h3>
      <p class="muted">{t("configView.appearance.lobsterPacksDescription")}</p>
      <div class="settings-appearance-discovery__links">
        <a
          class="btn btn--sm"
          href={pathForRoute("plugin-settings", application.basePath)}
          onClick={(event) =>
            navigate(
              event,
              "plugin-settings",
              pathForRoute("plugin-settings", application.basePath),
            )
          }
        >
          {t("configView.appearance.managePacks")}
        </a>
        <Show when={props.lobsterdexHref && branding.read().lobsterdex}>
          <a
            class="btn btn--sm"
            href={props.lobsterdexHref}
            onClick={(event) => handleNavigationClick(event, () => props.onOpenLobsterdex?.())}
          >
            {t("configView.appearance.viewLobsterdex")}
          </a>
        </Show>
      </div>
      <input
        type="search"
        class="settings-theme-import__input"
        value={state.read().query}
        maxlength={200}
        aria-label={t("configView.appearance.searchPacks")}
        placeholder={t("configView.appearance.searchPacks")}
        onInput={(event) => discovery.updateQuery(event.currentTarget.value)}
      />
      <Show when={!connected()}>
        <p role="status">{t("configView.appearance.connectForPacks")}</p>
      </Show>
      <Loading on={state.read().reads.browse} fallback={<p role="status">{t("common.loading")}</p>}>
        <Errored
          fallback={(error, reset) => (
            <p class="settings-status settings-status--error" role="alert">
              {formatUiError(error())}{" "}
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => {
                  void discovery.refresh();
                  reset();
                }}
              >
                {t("common.retry")}
              </button>
            </p>
          )}
        >
          {ready()}
        </Errored>
      </Loading>
      <Show when={state.read().remoteError || state.read().loadMoreError}>
        <p role="alert" class="settings-status settings-status--error">
          {state.read().remoteError || state.read().loadMoreError}{" "}
          <button type="button" class="btn btn--sm" onClick={() => void discovery.refresh()}>
            {t("common.retry")}
          </button>
        </p>
      </Show>
      <Show when={state.read().hasCurrentResult}>
        <div class="settings-theme-discovery__results">
          <For each={state.read().result?.items ?? []} keyed={(item) => item.id}>
            {(item) => (
              <article class="settings-theme-discovery__card">
                <div>
                  <strong>{item().catalog.name}</strong>
                  <p>{item().catalog.summary}</p>
                  <span class="muted">
                    {item().local.installed
                      ? t("configView.appearance.packInstalled")
                      : item().catalog.author}
                  </span>
                </div>
                <a
                  class="btn btn--sm"
                  href={href(item())}
                  onClick={(event) =>
                    navigate(
                      event,
                      item().local.installed && item().local.pluginId
                        ? "plugin-settings"
                        : "plugins",
                      href(item()),
                    )
                  }
                >
                  {item().local.installed
                    ? t("configView.appearance.managePack")
                    : t("configView.appearance.reviewPack")}
                </a>
              </article>
            )}
          </For>
        </div>
        <Show when={!state.read().result?.items.length && !state.read().remoteError}>
          <p class="muted" role="status">
            {t("configView.appearance.noPacks")}
          </p>
        </Show>
        <Show when={state.read().result?.nextCursor}>
          <Loading
            on={state.read().reads.more}
            fallback={
              <button class="btn btn--sm" type="button" disabled>
                {t("common.loading")}
              </button>
            }
          >
            {more()}
            <button class="btn btn--sm" type="button" onClick={() => void discovery.loadMore()}>
              {t("configView.appearance.moreThemes")}
            </button>
          </Loading>
        </Show>
      </Show>
    </div>
  );
}
