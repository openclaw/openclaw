import type { JSX } from "@solidjs/web";
import { children, createMemo, Show } from "solid-js";
import type { ThemeColorMode } from "../../../packages/gateway-protocol/src/theme.ts";
import type { CatalogTheme } from "../app/theme-catalog.ts";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";

export type ThemeChatPalette = Pick<
  CatalogTheme["palette"]["dark"],
  "bg" | "text" | "card" | "card-foreground" | "primary" | "primary-foreground" | "border" | "muted"
> &
  Partial<Pick<CatalogTheme["palette"]["dark"], "font-body">>;

/** Rendering only: callers own palette readiness, mode selection and artwork loading. */
export function ThemeChatPreview(props: {
  palette?: ThemeChatPalette;
  mode?: ThemeColorMode;
  background?: JSX.Element;
  label?: string;
  children?: JSX.Element;
}) {
  const content = children(() => props.children);
  const style = createMemo(() => {
    const palette = props.palette;
    return palette
      ? {
          "--bg": palette.bg,
          "--text": palette.text,
          "--text-strong": palette.text,
          "--card": palette.card,
          "--card-foreground": palette["card-foreground"],
          "--primary": palette.primary,
          "--primary-foreground": palette["primary-foreground"],
          "--border": palette.border,
          "--muted": palette.muted,
          "--font-body": palette["font-body"],
          "color-scheme": props.mode,
        }
      : undefined;
  });
  return (
    <section
      class="plugin-recommended-prompts plugin-theme-preview__chat"
      style={style()}
      inert={!content()}
      aria-label={props.label ?? t("pluginsPage.themePreview.label")}
    >
      <Show when={props.background}>
        {(background) => <div class="plugin-theme-preview__background">{background()}</div>}
      </Show>
      <div class="plugin-recommended-prompts__list plugin-theme-preview__content">
        <span class="plugin-prompt-mention card-title plugin-theme-preview__brand">
          <span class="plugin-prompt-mention__icon">
            <Icon name="mark" />
          </span>{" "}
          OpenClaw
        </span>
        <Show
          when={content()}
          fallback={
            <>
              <div class="card-title">{t("pluginsPage.themePreview.greeting")}</div>
              <div class="btn plugin-recommended-prompts__prompt" aria-hidden="true">
                <span class="plugin-recommended-prompts__text muted">
                  {t("pluginsPage.themePreview.composer")}
                </span>
                <span class="btn primary plugin-recommended-prompts__action">
                  <Icon name="arrowUp" />
                </span>
              </div>
            </>
          }
        >
          {content()}
        </Show>
      </div>
    </section>
  );
}
