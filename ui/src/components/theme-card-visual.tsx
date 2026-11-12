import { createMemo, Show } from "solid-js";
import type { ThemeColorMode } from "../../../packages/gateway-protocol/src/theme.ts";
import type { CatalogTheme } from "../app/theme-catalog.ts";
import type { ThemeName } from "../app/theme.ts";
import { Icon } from "./solid/icon.tsx";

export type ThemeCardPalette = Record<
  ThemeColorMode,
  Pick<CatalogTheme["palette"]["dark"], "bg" | "text" | "accent" | "accent-2">
>;

/* Builtin cards preview their real palette (chip colors live in config.css,
   mirrored from the base.css theme blocks). Catalog cards use their cached palette.
   Only the inactive custom import card falls back to the download icon. */
export function ThemeCardVisual(props: {
  id: ThemeName;
  activeTheme: ThemeName;
  selected?: boolean;
  palette?: ThemeCardPalette;
}) {
  const previewStyle = createMemo(() => {
    const palette = props.palette;
    if (!palette) {
      // Catalog cards stay neutral until their own palette is available.
      return props.id.includes("/")
        ? {
            "--theme-chip-bg": "var(--bg-hover)",
            "--theme-chip-accent": "var(--muted)",
            "--theme-chip-accent-2": "var(--muted)",
          }
        : undefined;
    }
    return {
      "--theme-chip-bg": `light-dark(${palette.light.bg}, ${palette.dark.bg})`,
      "--theme-chip-ink": `light-dark(${palette.light.text}, ${palette.dark.text})`,
      "--theme-chip-accent": `light-dark(${palette.light.accent}, ${palette.dark.accent})`,
      "--theme-chip-accent-2": `light-dark(${palette.light["accent-2"]}, ${palette.dark["accent-2"]})`,
    };
  });
  return (
    <span class="settings-theme-card__swatch" aria-hidden="true" style={previewStyle()}>
      <Show
        when={props.id !== "custom" || props.activeTheme === props.id}
        fallback={
          <span class="settings-theme-card__icon">
            <Icon name="download" />
          </span>
        }
      >
        <span class="settings-theme-card__palette">
          <span class="settings-theme-card__line" />
          <span class="settings-theme-card__line settings-theme-card__line--short" />
          <span class="settings-theme-card__chips">
            <span class="settings-theme-card__chip settings-theme-card__chip--accent" />
            <span class="settings-theme-card__chip settings-theme-card__chip--accent-2" />
          </span>
        </span>
      </Show>
      <Show when={props.selected}>
        <span class="settings-theme-card__check">
          <Icon name="check" />
        </span>
      </Show>
    </span>
  );
}
