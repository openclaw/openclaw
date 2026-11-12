import { createMemo, For, Show } from "solid-js";
import type {
  ThemeColorMode,
  ThemeDescriptor,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ThemeCatalogSnapshot } from "../../app/theme-catalog.ts";
import { PluginThemeArtwork } from "../../components/plugin-theme-artwork.tsx";
import { ThemeChatPreview } from "../../components/theme-chat-preview.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginRetryError } from "./settings-retry-error.tsx";

export function PluginThemePreview(props: {
  themes: readonly ThemeDescriptor[];
  palettes: ThemeCatalogSnapshot["palettes"];
  mode: ThemeColorMode;
  error?: ThemeCatalogSnapshot["error"];
  onRetry: () => void;
}) {
  const missingPalette = createMemo(() =>
    props.themes.some((theme) => !props.palettes?.has(theme.id)),
  );
  const error = () => (missingPalette() ? props.error : null);
  return (
    <Show when={props.themes.length}>
      <Show when={error()}>
        {(failure) => (
          <PluginRetryError error={formatUiError(failure())} onRetry={() => props.onRetry()} />
        )}
      </Show>
      <section class="plugin-theme-preview" aria-label={t("pluginsPage.themePreview.label")}>
        <For each={props.themes} keyed={(theme) => theme.id}>
          {(theme) => {
            // A validated descriptor has at least one mode; an unavailable mode uses its counterpart.
            const mode = () =>
              theme().modes.includes(props.mode)
                ? props.mode
                : props.mode === "dark"
                  ? "light"
                  : "dark";
            const palette = () => props.palettes?.get(theme().id)?.[mode()];
            const background = () => theme().artwork?.backgrounds?.[mode()]?.url;
            return (
              <figure class="plugin-theme-preview__theme">
                <figcaption class="card-sub">{theme().name}</figcaption>
                <Show
                  when={palette()}
                  fallback={
                    error() ? undefined : (
                      <div
                        class="plugin-recommended-prompts plugin-theme-preview__chat skeleton"
                        aria-hidden="true"
                      />
                    )
                  }
                >
                  {(colors) => (
                    <ThemeChatPreview
                      palette={colors()}
                      mode={mode()}
                      background={
                        <Show when={background()}>
                          {(url) => <PluginThemeArtwork url={url()} background />}
                        </Show>
                      }
                    />
                  )}
                </Show>
              </figure>
            );
          }}
        </For>
      </section>
    </Show>
  );
}
