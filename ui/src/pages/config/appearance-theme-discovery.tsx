import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { createThemeDiscovery } from "../../app/theme-discovery.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { ConfigProps } from "./view-types.ts";

export function AppearanceThemeDiscovery(props: Pick<ConfigProps, "themeCatalog" | "theme">) {
  const application = useApplication();
  const owner = createThemeDiscovery(application.gateway, () => application.theme.retryCatalog?.());
  const state = projectOwner(owner, (value) => value.snapshot);
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const installed = createMemo(
    () => props.themeCatalog?.themes.filter((theme) => theme.source === "user") ?? [],
  );
  onSettled(() => () => owner.dispose());
  return (
    <div class="settings-theme-discovery">
      <button
        class="btn btn--sm"
        type="button"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => {
          if (!open()) {
            void owner.browse();
          }
          setOpen((value) => !value);
        }}
      >
        <Icon name="search" /> {t("configView.appearance.discoverThemes")}
      </button>
      <Show when={open()}>
        <div class="settings-theme-discovery__panel">
          <h3>{t("configView.appearance.clawhubThemes")}</h3>
          <p class="muted">{t("configView.appearance.themeDataOnly")}</p>
          <form
            class="settings-theme-discovery__search"
            onSubmit={(event) => {
              event.preventDefault();
              void owner.browse(query());
            }}
          >
            <input
              type="search"
              class="settings-theme-import__input"
              value={query()}
              aria-label={t("configView.appearance.searchThemes")}
              placeholder={t("configView.appearance.searchThemes")}
              maxlength={160}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <button class="btn btn--sm" type="submit" disabled={state.read().loading}>
              {t("common.search")}
            </button>
          </form>
          <Show when={state.read().error}>
            {(error) => (
              <p class="settings-status settings-status--error" role="alert">
                {error()}
              </p>
            )}
          </Show>
          <Show when={state.read().saved}>
            {(saved) => (
              <p role="status" class="settings-status">
                {t(
                  saved() === "install"
                    ? "configView.appearance.themeInstalled"
                    : "configView.appearance.themeRemoved",
                )}
              </p>
            )}
          </Show>
          <Show when={state.read().loading}>
            <p role="status" class="muted">
              {t("common.loading")}
            </p>
          </Show>
          <div
            class="settings-theme-discovery__results"
            aria-busy={state.read().loading ? "true" : "false"}
          >
            <For each={state.read().page?.items ?? []} keyed={(theme) => theme.id}>
              {(theme) => (
                <article class="settings-theme-discovery__card">
                  <div>
                    <strong>{theme().name}</strong>
                    <div class="muted">
                      {theme().author.handle} · {theme().version}
                    </div>
                    <p>{theme().description}</p>
                  </div>
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={state.read().mutation !== null}
                    onClick={() => void owner.mutate("install", theme().id, theme().version)}
                  >
                    {state.read().mutation === theme().id
                      ? t("configView.appearance.installingTheme")
                      : t("configView.appearance.installTheme")}
                  </button>
                </article>
              )}
            </For>
          </div>
          <Show
            when={state.read().page && !state.read().page?.items.length && !state.read().loading}
          >
            <p class="muted">{t("configView.appearance.noThemes")}</p>
          </Show>
          <Show when={state.read().page?.nextCursor}>
            {(cursor) => (
              <button
                type="button"
                class="btn btn--sm"
                disabled={state.read().loading}
                onClick={() => void owner.browse(state.read().query, cursor())}
              >
                {t("configView.appearance.moreThemes")}
              </button>
            )}
          </Show>
          <Show when={installed().length}>
            <h3>{t("configView.appearance.personalThemes")}</h3>
            <p class="muted">{t("configView.appearance.personalThemesHint")}</p>
            <For each={installed()} keyed={(theme) => theme.id}>
              {(theme) => (
                <div class="settings-theme-discovery__installed">
                  <span>
                    {theme().name}
                    {theme().id === props.theme
                      ? " · " + t("configView.appearance.activeTheme")
                      : ""}
                  </span>
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={state.read().mutation !== null}
                    onClick={() => void owner.mutate("remove", theme().id)}
                  >
                    {t("common.remove")}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
