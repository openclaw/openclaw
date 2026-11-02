import type { JSX } from "@solidjs/web";
import { Errored, For, Loading, Show, createMemo, lazy } from "solid-js";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon, sessionIconMask } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsPageHeader,
} from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createProgressiveList } from "../../lib/reactive/progressive-list.ts";
import { PluginArtTile } from "./consent-dialog.tsx";
import { renderPluginCompatibilityNotices } from "./overview.tsx";
import { renderPluginStateStatus } from "./plugin-card.tsx";
import { pluginRowKey, renderPluginRowMessage } from "./plugin-row-message.tsx";
import { PluginRetryError } from "./settings-retry-error.tsx";
import type { InventoryProps } from "./settings-view.tsx";

const AdvancedSettings = lazy(() => import("./settings-advanced.tsx"), {
  export: "AdvancedSettings",
});

function InstalledInventory(props: InventoryProps): JSX.Element {
  const query = createMemo(() => props.query.trim().toLocaleLowerCase().normalize("NFC"));
  const plugins = createMemo(() =>
    (props.result?.plugins ?? [])
      .filter(
        (plugin) =>
          plugin.installed &&
          (!query() ||
            [plugin.name, plugin.id, plugin.description, plugin.packageName].some((value) =>
              value?.toLocaleLowerCase().normalize("NFC").includes(query()),
            )),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  );
  return (
    <Show
      when={props.result}
      fallback={
        <div class="settings-group oc-settings-group">
          {!props.connected ? (
            <SettingsEmpty message={t("pluginsPage.connectToManage")} carapace />
          ) : props.loading ? (
            <SettingsLoadingSkeleton rows={4} carapace />
          ) : props.error ? (
            <PluginRetryError error={props.error} onRetry={props.onRefresh} />
          ) : (
            <SettingsEmpty
              message={
                props.query ? t("pluginsPage.noSettingsMatches") : t("pluginsPage.noInstalled")
              }
              carapace
            />
          )}
        </div>
      }
    >
      <InstalledRows {...props} plugins={plugins()} />
    </Show>
  );
}

function InstalledRows(
  props: InventoryProps & {
    plugins: NonNullable<InventoryProps["result"]>["plugins"];
  },
): JSX.Element {
  const visible = createProgressiveList(() => props.plugins, { initial: 20, batch: 200 });
  return (
    <div class="settings-group oc-settings-group" aria-busy={visible.pending() ? "true" : "false"}>
      {props.error ? <PluginRetryError error={props.error} onRetry={props.onRefresh} /> : null}
      <Show
        when={props.plugins.length > 0}
        fallback={
          <SettingsEmpty
            message={
              props.query ? t("pluginsPage.noSettingsMatches") : t("pluginsPage.noInstalled")
            }
            carapace
          />
        }
      >
        <For each={visible.items()} keyed={(plugin) => plugin.id}>
          {(plugin) => (
            <article
              class="settings-row settings-row--nav plugins-settings-row oc-settings-row"
              data-plugin-id={plugin().id}
              onClick={(event: Event) => {
                const target = event.target;
                if (!(target instanceof Element) || !target.closest("button, a")) {
                  props.onOpenPlugin(plugin().id);
                }
              }}
            >
              <PluginArtTile
                registerIcon={props.registerIcon}
                slug={plugin().id}
                name={plugin().name}
                iconUrl={props.iconUrls[plugin().id]}
                onIconError={() => props.onIconError(plugin().id)}
                loading={props.iconLoading?.(plugin().id)}
              />
              <div class="settings-row__text oc-settings-row-content">
                <a
                  class="settings-row__text plugins-settings-row__link"
                  href={props.pluginHref(plugin().id)}
                  onClick={(event: MouseEvent) =>
                    handleNavigationClick(event, () => props.onOpenPlugin(plugin().id))
                  }
                >
                  <span class="settings-row__title oc-settings-row-title">{plugin().name}</span>
                  <span class="settings-row__desc oc-settings-row-description">
                    {plugin().description || t("pluginsPage.optionalCapability")}
                  </span>
                </a>
                {renderPluginCompatibilityNotices(plugin().compatibilityNotices)}
              </div>
              <div class="settings-row__control oc-settings-row-control">
                {(() => {
                  const state = plugin().state;
                  return state === "not-installed"
                    ? null
                    : renderPluginStateStatus(state, "plugins-settings-row__status");
                })()}
                <span class="settings-row__chevron" aria-hidden="true">
                  <i
                    class="session-css-icon"
                    style={{ "mask-image": sessionIconMask("chevronRight") }}
                  />
                </span>
              </div>
              {renderPluginRowMessage(props.messages[pluginRowKey(plugin().id)])}
            </article>
          )}
        </For>
      </Show>
    </div>
  );
}

export function renderPluginSettingsInventory(props: InventoryProps): JSX.Element {
  const body = (
    <>
      {props.tab === "installed" ? (
        <>
          <label class="plugins-settings-search">
            <span class="settings-control__sr-label">{t("pluginsPage.searchInstalled")}</span>
            <span aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              class="settings-input oc-input"
              type="search"
              aria-label={t("pluginsPage.searchInstalled")}
              placeholder={t("pluginsPage.searchInstalled")}
              value={props.query}
              onInput={(event) => props.onQueryChange(event.currentTarget.value)}
            />
          </label>
          <InstalledInventory {...props} />
        </>
      ) : (
        <Errored
          fallback={(error, reset) => (
            <PluginRetryError error={formatUiError(error())} onRetry={reset} />
          )}
        >
          <Loading fallback={<SettingsLoadingSkeleton rows={4} carapace />}>
            <AdvancedSettings {...props} />
          </Loading>
        </Errored>
      )}
    </>
  );
  return (
    <SettingsPage carapace={true}>
      <SettingsPageHeader
        registerHeading={props.registerRemovalHeading}
        title={t("tabs.plugins")}
        subtitle={t("pluginsPage.settingsDescription")}
      />
      <div class="plugins-settings-content">
        <HubTabs
          id="plugin-settings"
          active={props.tab}
          tabs={[
            { value: "installed", label: t("pluginsPage.settingsInstalled") },
            { value: "advanced", label: t("pluginsPage.advanced") },
          ]}
          ariaLabel={t("pluginsPage.settingsTabs")}
          panelId="plugin-settings-panel"
          variant="sub"
          class="plugins-settings-tabs"
          carapace
          onSelect={props.onTabChange}
        />
        <div
          id="plugin-settings-panel"
          role="tabpanel"
          aria-labelledby={`plugin-settings-tab-${props.tab}`}
        >
          {body}
        </div>
      </div>
    </SettingsPage>
  );
}
